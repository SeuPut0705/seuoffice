//! The folders `zip.file(name, data)` adds above a file. Expected lists are
//! `Object.keys(zip.files)` (with `dir`) of JSZip 3.10.1 after the same
//! `zip.file()` calls, under Node 22.

use ooxml_pkg::Package;

fn folders_and_files(names: &[&str]) -> Vec<(String, bool)> {
    let package = Package::from_parts(names.iter().map(|name| (*name, "x")));
    package
        .parts()
        .iter()
        .map(|part| (part.name.to_string(), part.is_dir))
        .collect()
}

#[test]
fn a_parent_that_ends_in_a_slash_keeps_one_slash() {
    let expected = [("a/", true), ("a//b/", true), ("a//b/c.txt", false)];
    assert_eq!(
        folders_and_files(&["a//b/c.txt"]),
        expected.map(|(name, dir)| (name.to_owned(), dir))
    );
    let expected = [
        ("/a/", true),
        ("/a//b/", false),
        ("c/", true),
        ("c//", true),
        ("c///d", false),
    ];
    assert_eq!(
        folders_and_files(&["/a//b/", "c///d"]),
        expected.map(|(name, dir)| (name.to_owned(), dir))
    );
}

#[test]
fn a_name_ending_in_a_slash_is_a_file_with_the_folders_above_it() {
    let expected = [("x/", true), ("x/y/", false), ("x//", false)];
    assert_eq!(
        folders_and_files(&["x/y/", "x//"]),
        expected.map(|(name, dir)| (name.to_owned(), dir))
    );
}

fn layout(package: &Package) -> Vec<(String, bool)> {
    package
        .parts()
        .iter()
        .map(|part| (part.name.to_string(), part.is_dir))
        .collect()
}

#[test]
fn remove_all_equals_removes_in_sequence() {
    let names = [
        "[Content_Types].xml",
        "a/b/c.txt",
        "a/b/d.txt",
        "a/e.txt",
        "a",
        "a/",
        "f/g/h.txt",
        "f/g",
        "x.xml",
        "x.xml/y.xml",
        "customXml/item1.xml",
        "customXml/item2.xml",
        "customXml/_rels/item1.xml.rels",
    ];
    let removals: [&[&str]; 8] = [
        &["customXml/item1.xml", "customXml/item2.xml"],
        &["a/b", "a/b/c.txt", "a/b/c.txt"],
        &["a/b/c.txt", "a/b/c.txt"],
        &["x.xml", "x.xml"],
        &["f", "f/g/h.txt", "missing", "missing/"],
        &["customXml/", "customXml/item1.xml"],
        &["a", "a/b/d.txt", "[Content_Types].xml"],
        &[],
    ];
    for removal in removals {
        let mut sequential = Package::from_parts(names.iter().map(|name| (*name, "x")));
        for name in removal {
            sequential.remove(name);
        }
        let mut batch = Package::from_parts(names.iter().map(|name| (*name, "x")));
        batch.remove_all(removal);
        assert_eq!(layout(&batch), layout(&sequential), "removing {removal:?}");
        for name in names {
            assert_eq!(
                batch.has(name),
                sequential.has(name),
                "{name} after {removal:?}"
            );
        }
    }
}

#[test]
fn removing_thousands_of_parts_in_one_batch_is_linear() {
    let names: Vec<String> = (0..20_000)
        .map(|n| format!("customXml/item{n}.xml"))
        .collect();
    let mut package = Package::from_parts(names.iter().map(|name| (name.as_str(), "x")));
    package.remove_all(&names);
    assert_eq!(layout(&package), vec![("customXml/".to_owned(), true)]);
}
