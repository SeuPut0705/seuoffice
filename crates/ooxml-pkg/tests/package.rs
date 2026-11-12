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
