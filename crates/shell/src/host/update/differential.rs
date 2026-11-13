//! electron-updater's block-map differential download
//! (`differentialDownloader/downloadPlanBuilder.ts`): a release publishes
//! `<file>.blockmap` beside each update file, a gzipped JSON list of the
//! file's content-defined blocks (`{version, files: [{name, offset,
//! checksums, sizes}]}`). The blocks the old file already has are copied
//! from it, only the others are downloaded.

use std::collections::HashMap;
use std::io::Read;
use std::ops::Range;

use serde_json::Value;

/// One `.blockmap`
#[derive(Debug, PartialEq)]
pub struct BlockMap {
    version: String,
    files: Vec<BlockFile>,
}

#[derive(Debug, PartialEq)]
struct BlockFile {
    name: String,
    offset: u64,
    checksums: Vec<String>,
    sizes: Vec<u64>,
}

impl BlockMap {
    /// A `.blockmap` file as the release and the cache keep it: gzipped JSON
    pub fn parse(gzipped: &[u8]) -> Result<Self, String> {
        if gzipped.is_empty() {
            return Err("the block map is empty".into());
        }
        let mut text = String::new();
        flate2::read::GzDecoder::new(gzipped)
            .read_to_string(&mut text)
            .map_err(|e| format!("cannot unpack the block map: {e}"))?;
        let value: Value =
            serde_json::from_str(&text).map_err(|e| format!("cannot parse the block map: {e}"))?;
        let version = value["version"]
            .as_str()
            .ok_or("the block map has no version")?
            .to_owned();
        let files = value["files"]
            .as_array()
            .ok_or("the block map has no files")?
            .iter()
            .map(BlockFile::parse)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(BlockMap { version, files })
    }
}

impl BlockFile {
    fn parse(value: &Value) -> Result<Self, String> {
        let name = value["name"]
            .as_str()
            .ok_or("a block map file has no name")?;
        let offset = value["offset"]
            .as_u64()
            .ok_or("a block map file has no offset")?;
        let checksums = value["checksums"]
            .as_array()
            .ok_or("a block map file has no checksums")?
            .iter()
            .map(|c| c.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .ok_or("a block checksum is not a string")?;
        let sizes = value["sizes"]
            .as_array()
            .ok_or("a block map file has no sizes")?
            .iter()
            .map(Value::as_u64)
            .collect::<Option<Vec<_>>>()
            .ok_or("a block size is not a number")?;
        if checksums.len() != sizes.len() {
            return Err(format!(
                "{name}: {} checksums for {} blocks",
                checksums.len(),
                sizes.len()
            ));
        }
        Ok(BlockFile {
            name: name.to_owned(),
            offset,
            checksums,
            sizes,
        })
    }
}

/// One step of writing the new file, in order: a byte range of the old file,
/// or one of the new file to download
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Op {
    Copy(Range<u64>),
    Download(Range<u64>),
}

impl Op {
    pub fn len(&self) -> u64 {
        match self {
            Op::Copy(r) | Op::Download(r) => r.end - r.start,
        }
    }
}

/// `computeOperations(oldBlockMap, newBlockMap)`, with `doDownload`'s version
/// check: neighbouring blocks of one kind merge into one range, a block whose
/// checksum the old file has with another size is downloaded
pub fn plan(old: &BlockMap, new: &BlockMap) -> Result<Vec<Op>, String> {
    if old.version != new.version {
        return Err(format!(
            "block map versions differ ({} - {}), the whole file is needed",
            old.version, new.version
        ));
    }
    // electron-builder writes one file per block map
    let new_file = new.files.first().ok_or("the new block map lists no file")?;
    // the last of a name wins, as a Map built from the list does
    let old_file = old
        .files
        .iter()
        .rev()
        .find(|f| f.name == new_file.name)
        .ok_or_else(|| format!("no file {} in the old block map", new_file.name))?;
    // the first block of a checksum is the one copied
    let mut in_old: HashMap<&str, (u64, u64)> = HashMap::new();
    let mut offset = old_file.offset;
    for (checksum, &size) in old_file.checksums.iter().zip(&old_file.sizes) {
        in_old.entry(checksum).or_insert((offset, size));
        offset += size;
    }
    let mut ops: Vec<Op> = Vec::new();
    let mut offset = new_file.offset;
    for (checksum, &size) in new_file.checksums.iter().zip(&new_file.sizes) {
        let op = match in_old.get(checksum.as_str()) {
            Some(&(at, old_size)) if old_size == size => Op::Copy(at..at + size),
            _ => Op::Download(offset..offset + size),
        };
        offset += size;
        match (ops.last_mut(), op) {
            (Some(Op::Copy(last)), Op::Copy(next)) if last.end == next.start => {
                last.end = next.end;
            }
            (Some(Op::Download(last)), Op::Download(next)) if last.end == next.start => {
                last.end = next.end;
            }
            (_, op) => ops.push(op),
        }
    }
    Ok(ops)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn map(version: &str, blocks: &[(&str, u64)]) -> BlockMap {
        BlockMap {
            version: version.into(),
            files: vec![BlockFile {
                name: "file".into(),
                offset: 0,
                checksums: blocks.iter().map(|b| b.0.to_owned()).collect(),
                sizes: blocks.iter().map(|b| b.1).collect(),
            }],
        }
    }

    #[test]
    fn unchanged_blocks_are_copied_and_changed_ones_downloaded_in_merged_ranges() {
        let old = map("2", &[("a", 10), ("b", 20), ("c", 30), ("d", 40)]);
        // a block inserted after a, c changed, b and d kept (d moved)
        let new = map(
            "2",
            &[
                ("a", 10),
                ("x", 5),
                ("b", 20),
                ("y", 7),
                ("z", 3),
                ("d", 40),
            ],
        );
        assert_eq!(
            plan(&old, &new).unwrap(),
            vec![
                Op::Copy(0..10),
                Op::Download(10..15),
                Op::Copy(10..30),
                Op::Download(35..45),
                Op::Copy(60..100),
            ]
        );
    }

    #[test]
    fn neighbouring_old_blocks_copy_as_one_range_and_a_same_checksum_of_another_size_downloads() {
        let old = map("2", &[("a", 10), ("b", 20)]);
        let new = map("2", &[("a", 10), ("b", 20), ("a", 11)]);
        let ops = plan(&old, &new).unwrap();
        assert_eq!(ops, vec![Op::Copy(0..30), Op::Download(30..41)]);
        assert_eq!(ops.iter().map(Op::len).sum::<u64>(), 41);
    }

    #[test]
    fn block_maps_of_different_versions_or_files_need_the_whole_file() {
        assert!(plan(&map("1", &[("a", 1)]), &map("2", &[("a", 1)])).is_err());
        let mut other = map("2", &[("a", 1)]);
        other.files[0].name = "other".into();
        assert!(plan(&other, &map("2", &[("a", 1)])).is_err());
    }

    #[test]
    fn a_gzipped_block_map_parses_and_a_broken_one_does_not() {
        let json = br#"{"version":"2","files":[{"name":"file","offset":0,"checksums":["q83v","EjRW"],"sizes":[16384,9001]}]}"#;
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(json).unwrap();
        let parsed = BlockMap::parse(&gz.finish().unwrap()).unwrap();
        assert_eq!(parsed, map("2", &[("q83v", 16384), ("EjRW", 9001)]));
        assert!(BlockMap::parse(b"").is_err());
        assert!(BlockMap::parse(json).is_err());
    }
}
