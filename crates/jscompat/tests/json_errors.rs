//! `JSON.parse` refusals worded as Node 22 (V8 12.4) words them: 411 inputs, each with
//! `error.message`. A lone surrogate in a message (the token, or an excerpt cut
//! inside a pair) is U+FFFD.
//!
//! Generated, do not edit; to regenerate, from the repository root:
//!   PATH=/opt/homebrew/opt/node@22/bin:$PATH node crates/jscompat/tests/gen_json_errors.mjs

use jscompat::json_parse;

const CASES: &[(&str, &str)] = &[
    ("", "Unexpected end of JSON input"),
    (" ", "Unexpected end of JSON input"),
    (" \u{9}\u{d}\u{a} ", "Unexpected end of JSON input"),
    ("\u{a}\u{a}", "Unexpected end of JSON input"),
    ("x", "Unexpected token 'x', \"x\" is not valid JSON"),
    ("undefined", "\"undefined\" is not valid JSON"),
    ("NaN", "\"NaN\" is not valid JSON"),
    ("Infinity", "\"Infinity\" is not valid JSON"),
    ("[object Object]", "\"[object Object]\" is not valid JSON"),
    (
        "[object Object]x",
        "Unexpected token 'o', \"[object Object]x\" is not valid JSON",
    ),
    (
        "{",
        "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    ),
    (
        "{ ",
        "Expected property name or '}' in JSON at position 2 (line 1 column 3)",
    ),
    (
        "{\"a\"",
        "Expected ':' after property name in JSON at position 4 (line 1 column 5)",
    ),
    ("{\"a\":", "Unexpected end of JSON input"),
    (
        "{\"a\":1",
        "Expected ',' or '}' after property value in JSON at position 6 (line 1 column 7)",
    ),
    (
        "{\"a\":1,",
        "Expected double-quoted property name in JSON at position 7 (line 1 column 8)",
    ),
    (
        "{\"a\":1,}",
        "Expected double-quoted property name in JSON at position 7 (line 1 column 8)",
    ),
    (
        "{,}",
        "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    ),
    (
        "{1:2}",
        "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    ),
    (
        "{'a':1}",
        "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    ),
    (
        "{\"a\" 1}",
        "Expected ':' after property name in JSON at position 5 (line 1 column 6)",
    ),
    (
        "{\"a\":1 \"b\":2}",
        "Expected ',' or '}' after property value in JSON at position 7 (line 1 column 8)",
    ),
    (
        "{\"a\":1}}",
        "Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)",
    ),
    ("[", "Unexpected end of JSON input"),
    (
        "[1",
        "Expected ',' or ']' after array element in JSON at position 2 (line 1 column 3)",
    ),
    ("[1,", "Unexpected end of JSON input"),
    ("[1,]", "Unexpected token ']', \"[1,]\" is not valid JSON"),
    ("[,]", "Unexpected token ',', \"[,]\" is not valid JSON"),
    (
        "[1 2]",
        "Expected ',' or ']' after array element in JSON at position 3 (line 1 column 4)",
    ),
    (
        "[1}",
        "Expected ',' or ']' after array element in JSON at position 2 (line 1 column 3)",
    ),
    ("]", "Unexpected token ']', \"]\" is not valid JSON"),
    ("}", "Unexpected token '}', \"}\" is not valid JSON"),
    (":", "Unexpected token ':', \":\" is not valid JSON"),
    (",", "Unexpected token ',', \",\" is not valid JSON"),
    (
        "1 2",
        "Unexpected non-whitespace character after JSON at position 2 (line 1 column 3)",
    ),
    (
        "{} x",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "true false",
        "Unexpected non-whitespace character after JSON at position 5 (line 1 column 6)",
    ),
    (
        "null,",
        "Unexpected non-whitespace character after JSON at position 4 (line 1 column 5)",
    ),
    ("[tru", "Unexpected end of JSON input"),
    ("tru", "Unexpected end of JSON input"),
    ("trux", "Unexpected token 'x', \"trux\" is not valid JSON"),
    ("nul", "Unexpected end of JSON input"),
    ("nulx", "Unexpected token 'x', \"nulx\" is not valid JSON"),
    ("fals", "Unexpected end of JSON input"),
    ("falsy", "Unexpected token 'y', \"falsy\" is not valid JSON"),
    ("t", "Unexpected end of JSON input"),
    ("f", "Unexpected end of JSON input"),
    ("n", "Unexpected end of JSON input"),
    (
        "tr\"",
        "Unexpected string in JSON at position 2 (line 1 column 3)",
    ),
    (
        "nu1",
        "Unexpected number in JSON at position 2 (line 1 column 3)",
    ),
    (
        "true1",
        "Unexpected non-whitespace character after JSON at position 4 (line 1 column 5)",
    ),
    ("[nan]", "Unexpected token 'a', \"[nan]\" is not valid JSON"),
    (
        "\"abc",
        "Unterminated string in JSON at position 4 (line 1 column 5)",
    ),
    (
        "\"",
        "Unterminated string in JSON at position 1 (line 1 column 2)",
    ),
    ("\"\\", "Unexpected end of JSON input"),
    (
        "\"\\x\"",
        "Bad escaped character in JSON at position 2 (line 1 column 3)",
    ),
    (
        "\"\\u12",
        "Bad Unicode escape in JSON at position 5 (line 1 column 6)",
    ),
    (
        "\"\\u12G4\"",
        "Bad Unicode escape in JSON at position 5 (line 1 column 6)",
    ),
    (
        "\"\\u\"",
        "Bad Unicode escape in JSON at position 3 (line 1 column 4)",
    ),
    (
        "\"\\\u{e9}\"",
        "Bad escaped character in JSON at position 2 (line 1 column 3)",
    ),
    (
        "\"\\\u{20ac}\"",
        "Unexpected token '\u{20ac}', \"\"\\\u{20ac}\"\" is not valid JSON",
    ),
    (
        "\"\\\u{1f600}\"",
        "Unexpected token '\u{fffd}', \"\"\\\u{1f600}\"\" is not valid JSON",
    ),
    (
        "\"\\\u{a}\"",
        "Bad escaped character in JSON at position 2 (line 1 column 3)",
    ),
    (
        "\"a\u{9}b\"",
        "Bad control character in string literal in JSON at position 2 (line 1 column 3)",
    ),
    (
        "\"a\u{a}b\"",
        "Bad control character in string literal in JSON at position 2 (line 1 column 3)",
    ),
    (
        "\"\u{1}\"",
        "Bad control character in string literal in JSON at position 1 (line 1 column 2)",
    ),
    (
        "\"\u{e9}\\q\"",
        "Bad escaped character in JSON at position 3 (line 1 column 4)",
    ),
    (
        "{\"a\":\"b\u{a}c\"}",
        "Bad control character in string literal in JSON at position 7 (line 1 column 8)",
    ),
    (
        "{\"k\\x\":1}",
        "Bad escaped character in JSON at position 4 (line 1 column 5)",
    ),
    (
        "{\"1\\u00zz\":1}",
        "Bad Unicode escape in JSON at position 7 (line 1 column 8)",
    ),
    (
        "{\"abc",
        "Unterminated string in JSON at position 5 (line 1 column 6)",
    ),
    (
        "-",
        "No number after minus sign in JSON at position 1 (line 1 column 2)",
    ),
    (
        "-a",
        "No number after minus sign in JSON at position 1 (line 1 column 2)",
    ),
    (
        "--1",
        "No number after minus sign in JSON at position 1 (line 1 column 2)",
    ),
    (
        "01",
        "Unexpected number in JSON at position 1 (line 1 column 2)",
    ),
    (
        "-01",
        "Unexpected number in JSON at position 2 (line 1 column 3)",
    ),
    (
        "00",
        "Unexpected number in JSON at position 1 (line 1 column 2)",
    ),
    (
        "1.",
        "Unterminated fractional number in JSON at position 2 (line 1 column 3)",
    ),
    (
        "1.e5",
        "Unterminated fractional number in JSON at position 2 (line 1 column 3)",
    ),
    (
        "1e",
        "Exponent part is missing a number in JSON at position 2 (line 1 column 3)",
    ),
    (
        "1e+",
        "Exponent part is missing a number in JSON at position 3 (line 1 column 4)",
    ),
    (
        "1e-x",
        "Exponent part is missing a number in JSON at position 3 (line 1 column 4)",
    ),
    (
        "1E",
        "Exponent part is missing a number in JSON at position 2 (line 1 column 3)",
    ),
    (".5", "Unexpected token '.', \".5\" is not valid JSON"),
    ("+1", "Unexpected token '+', \"+1\" is not valid JSON"),
    (
        "1.5.5",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "[1.]",
        "Unterminated fractional number in JSON at position 3 (line 1 column 4)",
    ),
    (
        "{\"a\":1.}",
        "Unterminated fractional number in JSON at position 7 (line 1 column 8)",
    ),
    (
        "{\"a\":-}",
        "No number after minus sign in JSON at position 6 (line 1 column 7)",
    ),
    (
        "0x10",
        "Unexpected non-whitespace character after JSON at position 1 (line 1 column 2)",
    ),
    (
        "1e5e5",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "-0.",
        "Unterminated fractional number in JSON at position 3 (line 1 column 4)",
    ),
    (
        "[01]",
        "Unexpected number in JSON at position 2 (line 1 column 3)",
    ),
    (
        "[-]",
        "No number after minus sign in JSON at position 2 (line 1 column 3)",
    ),
    (
        "[1e]",
        "Exponent part is missing a number in JSON at position 3 (line 1 column 4)",
    ),
    (
        "[\u{a}1,\u{a}2,\u{a}}",
        "Unexpected token '}', \"[\u{a}1,\u{a}2,\u{a}}\" is not valid JSON",
    ),
    (
        "{\u{a}  \"a\": 1,\u{a}  \"b\": ,\u{a}}",
        "Unexpected token ',', ...\"1,\u{a}  \"b\": ,\u{a}}\" is not valid JSON",
    ),
    (
        "[\u{d}\u{a}1,\u{d}\u{a}]",
        "Unexpected token ']', \"[\u{d}\u{a}1,\u{d}\u{a}]\" is not valid JSON",
    ),
    (
        "[\u{d}\u{a}\u{d}\u{a}]]",
        "Unexpected non-whitespace character after JSON at position 6 (line 3 column 2)",
    ),
    (
        "[\u{d}]]",
        "Unexpected non-whitespace character after JSON at position 3 (line 2 column 2)",
    ),
    (
        "\u{d}\u{a}\u{d}\u{a}x",
        "Unexpected token 'x', \"\u{d}\u{a}\u{d}\u{a}x\" is not valid JSON",
    ),
    ("[1,\u{d}\u{a}", "Unexpected end of JSON input"),
    ("{\"a\":\u{d}", "Unexpected end of JSON input"),
    (
        "\u{1f600}\u{1f600}x",
        "Unexpected token '\u{fffd}', \"\u{1f600}\u{1f600}x\" is not valid JSON",
    ),
    (
        "[\"\u{1f600}\",\"\u{1f600}\",x]",
        "Unexpected token 'x', \"[\"\u{1f600}\",\"\u{1f600}\",x]\" is not valid JSON",
    ),
    (
        "\u{1f600}",
        "Unexpected token '\u{fffd}', \"\u{1f600}\" is not valid JSON",
    ),
    (
        "[\"\u{1f600}",
        "Unterminated string in JSON at position 4 (line 1 column 5)",
    ),
    (
        "{\"\u{1f600}\":}",
        "Unexpected token '}', \"{\"\u{1f600}\":}\" is not valid JSON",
    ),
    (
        "[1,\u{a}\"\u{1f600}\",\u{a}?]",
        "Unexpected token '?', \"[1,\u{a}\"\u{1f600}\",\u{a}?]\" is not valid JSON",
    ),
    (
        "\u{10ffff}\u{10ffff}",
        "Unexpected token '\u{fffd}', \"\u{10ffff}\u{10ffff}\" is not valid JSON",
    ),
    (
        "\u{e9}",
        "Unexpected token '\u{e9}', \"\u{e9}\" is not valid JSON",
    ),
    (
        "\u{3042}\u{3044}\u{3046}",
        "Unexpected token '\u{3042}', \"\u{3042}\u{3044}\u{3046}\" is not valid JSON",
    ),
    (
        "[\u{3042}]",
        "Unexpected token '\u{3042}', \"[\u{3042}]\" is not valid JSON",
    ),
    (
        "{\"a\":\u{3042}}",
        "Unexpected token '\u{3042}', \"{\"a\":\u{3042}}\" is not valid JSON",
    ),
    (
        "[1, \u{a0}]",
        "Unexpected token '\u{a0}', \"[1, \u{a0}]\" is not valid JSON",
    ),
    (
        "\u{feff}1",
        "Unexpected token '\u{feff}', \"\u{feff}1\" is not valid JSON",
    ),
    (
        "\u{2028}",
        "Unexpected token '\u{2028}', \"\u{2028}\" is not valid JSON",
    ),
    (
        "[1,\u{2028}]",
        "Unexpected token '\u{2028}', \"[1,\u{2028}]\" is not valid JSON",
    ),
    (
        "\u{1d4b3}",
        "Unexpected token '\u{fffd}', \"\u{1d4b3}\" is not valid JSON",
    ),
    (
        "[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,x]",
        "Unexpected token 'x', ...\",15,16,17,x]\" is not valid JSON",
    ),
    (
        "{\"a\":[1,2,{\"b\":tru}]}",
        "Unexpected token '}', ...\"2,{\"b\":tru}]}\" is not valid JSON",
    ),
    (
        "[[[[1,]]]]",
        "Unexpected token ']', \"[[[[1,]]]]\" is not valid JSON",
    ),
    (
        "[{\"a\":1},]",
        "Unexpected token ']', \"[{\"a\":1},]\" is not valid JSON",
    ),
    (
        "{\"a\":{\"b\":1,}}",
        "Expected double-quoted property name in JSON at position 12 (line 1 column 13)",
    ),
    (
        "{\"a\":[1,}",
        "Unexpected token '}', \"{\"a\":[1,}\" is not valid JSON",
    ),
    (
        "xxxxxxxxxxxxxxxxxxxx",
        "Unexpected token 'x', \"xxxxxxxxxxxxxxxxxxxx\" is not valid JSON",
    ),
    (
        "xxxxxxxxxxxxxxxxxxxxx",
        "Unexpected token 'x', \"xxxxxxxxxx\"... is not valid JSON",
    ),
    (
        "[                  x",
        "Unexpected token 'x', \"[                  x\" is not valid JSON",
    ),
    (
        "[                   x",
        "Unexpected token 'x', ...\"          x\" is not valid JSON",
    ),
    (
        "[         x           ",
        "Unexpected token 'x', ...\"[         x         \"... is not valid JSON",
    ),
    (
        "[          x          ",
        "Unexpected token 'x', ...\"          x         \"... is not valid JSON",
    ),
    (
        "[         x          ",
        "Unexpected token 'x', ...\"[         x         \"... is not valid JSON",
    ),
    (
        "[          x         ",
        "Unexpected token 'x', ...\"          x         \" is not valid JSON",
    ),
    (
        "[          x           ",
        "Unexpected token 'x', ...\"          x         \"... is not valid JSON",
    ),
    (
        "[          x                    ",
        "Unexpected token 'x', ...\"          x         \"... is not valid JSON",
    ),
    (
        "[                              x                              ",
        "Unexpected token 'x', ...\"          x         \"... is not valid JSON",
    ),
    (
        "[                              x",
        "Unexpected token 'x', ...\"          x\" is not valid JSON",
    ),
    (
        "x                              ",
        "Unexpected token 'x', \"x         \"... is not valid JSON",
    ),
    (
        "[1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,]",
        "Unexpected token ']', ...\"2,2,2,2,2,]\" is not valid JSON",
    ),
    (
        "{\"a\":1,\"b\":2,\"b\":2,\"b\":2,\"b\":2,\"b\":2,\"b\":2,\"b\":2,\"b\":2,\"b\":2,\"b\":2,}",
        "Expected double-quoted property name in JSON at position 67 (line 1 column 68)",
    ),
    (
        "[[[[[[[[[[[[[[[\u{1f600}]]]]]]]]]]]]]]]",
        "Unexpected token '\u{fffd}', ...\"[[[[[[[[[[\u{1f600}]]]]]]]]\"... is not valid JSON",
    ),
    (
        "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}x\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        "Unexpected token '\u{fffd}', \"\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\"... is not valid JSON",
    ),
    (
        "[\u{1f600}1,1,1,1,1,1,1,1,1,]",
        "Unexpected token '\u{fffd}', \"[\u{1f600}1,1,1,1,\"... is not valid JSON",
    ),
    (
        "\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\q\"",
        "Bad escaped character in JSON at position 42 (line 1 column 43)",
    ),
    (
        "\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\u{a}",
        "Bad control character in string literal in JSON at position 41 (line 1 column 42)",
    ),
    (
        "[\"\u{e9}\",\"\u{e9}\",\"\u{e9}\",\"\u{e9}\",\"\u{e9}\",\"\u{e9}\",\"\u{e9}\",\"\u{e9}\",\"\u{e9}\",\"\u{e9}\",\"\u{e9}\",\"\u{e9}\",\u{e9}]",
        "Unexpected token '\u{e9}', ...\"\",\"\u{e9}\",\"\u{e9}\",\u{e9}]\" is not valid JSON",
    ),
    (
        "1111111111111111111111111111111111111111z",
        "Unexpected non-whitespace character after JSON at position 40 (line 1 column 41)",
    ),
    (
        "[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,\u{e4},1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]",
        "Unexpected token '\u{e4}', ...\"1,1,1,1,1,\u{e4},1,1,1,1,\"... is not valid JSON",
    ),
    (
        "[{\"k\":\"v\"},[,",
        "Unexpected token ',', \"[{\"k\":\"v\"},[,\" is not valid JSON",
    ),
    ("k", "Unexpected token 'k', \"k\" is not valid JSON"),
    (
        "[{\"k\":\"v\"},[1,[2,[\u{9}3]\u{1f600}]",
        "Expected ',' or ']' after array element in JSON at position 21 (line 1 column 22)",
    ),
    (
        "nul{\"a\":[1,2.5,-3e{,true,false,null],\"b\":{\"c\u{3042}:\"d\\n\\u00e9\",",
        "Unexpected token '{', \"nul{\"a\":[1,2.\"... is not valid JSON",
    ),
    ("{\"a\":[1,2,", "Unexpected end of JSON input"),
    (
        "\\\u{3042}\"a\":[1,2.5,-3e2,true,false,",
        "Unexpected token '\\', \"\\\u{3042}\"a\":[1,2\"... is not valid JSON",
    ),
    (
        "[{\"k.\":\"",
        "Unterminated string in JSON at position 8 (line 1 column 9)",
    ),
    (
        "\"a\":[1,2.5,--e2,true,false,null,\"b\":{\"c\":\"d\\n\\u0",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "[{\"k\":\"v[},[1,[2,[3]]],\"\u{e9}\u{1f600}\",",
        "Expected ',' or '}' after property value in JSON at position 24 (line 1 column 25)",
    ),
    (
        "[{\"k\":\"v",
        "Unterminated string in JSON at position 8 (line 1 column 9)",
    ),
    (
        "\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  ",
        "Unexpected non-whitespace character after JSON at position 9 (line 2 column 9)",
    ),
    (
        " \"name\": \"x\",\u{a}  \"list\": [1, 2, 3",
        "Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)",
    ),
    (
        "[{\"k\":\"v\"},[1,[2,[3]]],\"\u{e9}",
        "Unterminated string in JSON at position 25 (line 1 column 26)",
    ),
    (
        "[{\"k\":\"v\"},[\\,[2,[3]]",
        "Unexpected token '\\', ...\"\"k\":\"v\"},[\\,[2,[3]]\" is not valid JSON",
    ),
    (
        "[{\"k\":\"v\"},[\u{1f600}1,[2,[3]]],\"\u{e9}\u{1f600}\",0",
        "Unexpected token '\u{fffd}', ...\"\"k\":\"v\"},[\u{1f600}1,[2,[3]\"... is not valid JSON",
    ),
    ("{\u{a}  \"name\": ", "Unexpected end of JSON input"),
    (
        "\":[1,2.5,-3e2,true,false,null],\"b\":",
        "Unexpected non-whitespace character after JSON at position 32 (line 1 column 33)",
    ),
    (
        "{\"a\":[1,2.5,-",
        "No number after minus sign in JSON at position 13 (line 1 column 14)",
    ),
    (
        "[{\"kv\"},\u{a}1,[2",
        "Expected ':' after property name in JSON at position 6 (line 1 column 7)",
    ),
    (":{", "Unexpected token ':', \":{\" is not valid JSON"),
    (
        "[{\"k\":\u{9}\"v\"},[1,[2,[3]]],\"\u{e9}\u{1f600}\",0.",
        "Unterminated fractional number in JSON at position 32 (line 1 column 33)",
    ),
    (
        "\"a\":[1,2.5,-3e2,true,false,null],\"b\":{\"c\":\"d\\n\\u00e",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "e{\"k\":\"v\"},[[,[2,[3]]],\"\u{e9}\u{1f600}\",0.5e-3]",
        "Unexpected token 'e', \"e{\"k\":\"v\"}\"... is not valid JSON",
    ),
    (
        ":{\"k\":\"v\"},[1,[2]]",
        "Unexpected token ':', \":{\"k\":\"v\"},[1,[2]]\" is not valid JSON",
    ),
    (
        "\"a\":[1,2.5,-3e2,true,false,null],\"b\":{\"c\"",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "nul{\u{a}  \"n",
        "Unexpected token '{', \"nul{\u{a}  \"n\" is not valid JSON",
    ),
    (
        "[{\"k\"},[1,[2",
        "Expected ':' after property name in JSON at position 5 (line 1 column 6)",
    ),
    (
        "\u{3042}{\"a\":[1,2.5,-3e2,true,false,null],\"b\":{\"c\":\"d\\n\\u",
        "Unexpected token '\u{3042}', \"\u{3042}{\"a\":[1,2\"... is not valid JSON",
    ),
    (
        "[{\"k\":\"v\"},[:,[2,[3]]]\u{a}\"\",0.5e",
        "Unexpected token ':', ...\"\"k\":\"v\"},[:,[2,[3]]]\"... is not valid JSON",
    ),
    (
        "\"kv\"},",
        "Unexpected non-whitespace character after JSON at position 4 (line 1 column 5)",
    ),
    (
        "[{\"k\":\"",
        "Unterminated string in JSON at position 7 (line 1 column 8)",
    ),
    (
        "\u{a} name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nested\": {",
        "Unexpected token 'a', \"\u{a} name\": \"x\",\"... is not valid JSON",
    ),
    (
        "\"a\":[1,2.5,-3e2,true,false,nu",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "tru}\"a\":[1,2.5,-3e2,true,false,null],\"",
        "Unexpected token '}', \"tru}\"a\":[1,2.\"... is not valid JSON",
    ),
    (
        "]{\"a\":[1,2.5,-3e2,true,fal",
        "Unexpected token ']', \"]{\"a\":[1,2\"... is not valid JSON",
    ),
    (
        "\u{a}x\u{a}  ",
        "Unexpected token 'x', \"\u{a}x\u{a}  \" is not valid JSON",
    ),
    (
        "]  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"",
        "Unexpected token ']', \"]  \"name\":\"... is not valid JSON",
    ),
    (
        "[{",
        "Expected property name or '}' in JSON at position 2 (line 1 column 3)",
    ),
    (
        "nul{\"a\":[1,2.5,-true2,true,false,nul",
        "Unexpected token '{', \"nul{\"a\":[1,2.\"... is not valid JSON",
    ),
    (
        "  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nested\": \": tru",
        "Unexpected non-whitespace character after JSON at position 8 (line 1 column 9)",
    ),
    (
        "  \"name\": ",
        "Unexpected non-whitespace character after JSON at position 8 (line 1 column 9)",
    ),
    (
        "  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nested\": {\"t\"",
        "Unexpected non-whitespace character after JSON at position 8 (line 1 column 9)",
    ),
    (
        "tru\"a\":[1,2.5,-3e2,tru",
        "Unexpected string in JSON at position 3 (line 1 column 4)",
    ),
    ("\u{a} ", "Unexpected end of JSON input"),
    (
        " \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nested\": {\"t\": true",
        "Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)",
    ),
    (
        "[{\"k\":\"v,},[1,[2,[3]]],\"\u{e9}\u{1f600}\",0.5e-3",
        "Expected ',' or '}' after property value in JSON at position 24 (line 1 column 25)",
    ),
    (
        "\"a\":[1,2.5,-3e2,true,false,n",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nested\": {\"t\": tru",
        "Unexpected non-whitespace character after JSON at position 9 (line 2 column 9)",
    ),
    (
        "\u{1}{\u{a}  \"n\u{a}me\": \"x\",\u{a}  \"li\": [1, 2, 3],\u{a}  \"nest",
        "Unexpected token '\u{1}', \"\u{1}{\u{a}  \"n\u{a}me\"... is not valid JSON",
    ),
    (
        "\"a\":[1,2.5,-3e2,true,false,null],\"",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "-{\u{a}  \"name\"]: \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nes",
        "No number after minus sign in JSON at position 1 (line 1 column 2)",
    ),
    (
        "a\":[1,2.5,-3e2,true,false,null],\"b\":{\"c\":\"d\\n\\u00e9\",\"e\"",
        "Unexpected token 'a', \"a\":[1,2.5,\"... is not valid JSON",
    ),
    (
        "\u{d}\u{a}{\"a\"",
        "Expected ':' after property name in JSON at position 6 (line 2 column 5)",
    ),
    (
        " \"name\": \"",
        "Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)",
    ),
    ("[{\"k\":", "Unexpected end of JSON input"),
    (
        "\"a[1",
        "Unterminated string in JSON at position 4 (line 1 column 5)",
    ),
    (
        "\u{1}{\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nested\": {\"t",
        "Unexpected token '\u{1}', \"\u{1}{\u{a}  \"name\"... is not valid JSON",
    ),
    (
        ":{\"a\":[1,2.5,-3e2,tre,false,null],\"b\":{\"",
        "Unexpected token ':', \":{\"a\":[1,2\"... is not valid JSON",
    ),
    (
        "0\"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"n",
        "Unexpected non-whitespace character after JSON at position 1 (line 1 column 2)",
    ),
    (
        " \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"ested\": {\"t\": true}\u{a}}",
        "Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)",
    ),
    (
        "[{\"k\",\"v",
        "Expected ':' after property name in JSON at position 5 (line 1 column 6)",
    ),
    (
        "\u{9}{\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nested\": {\"",
        "Unterminated string in JSON at position 53 (line 4 column 15)",
    ),
    (
        "  \"name\": \"x\",\u{a}  list\": [1, 2, 3],\u{a}  \"nested\": {",
        "Unexpected non-whitespace character after JSON at position 8 (line 1 column 9)",
    ),
    (
        "{\u{a}  \"name\": \"x\", \"list\": [1, 2, 3],\u{a}  \"nested\": {\"t\": }tru",
        "Unexpected token '}', ...\"d\": {\"t\": }tru\" is not valid JSON",
    ),
    (
        "[{\"k\":\"v},[1,[2,",
        "Unterminated string in JSON at position 16 (line 1 column 17)",
    ),
    (
        "}[{\"k\"\"v\"}:,[1,[2,[3]]],\"\u{e9}\u{1f600}",
        "Unexpected token '}', \"}[{\"k\"\"v\"}\"... is not valid JSON",
    ),
    (
        ".{\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"[ne",
        "Unexpected token '.', \".{\u{a}  \"name\"... is not valid JSON",
    ),
    (
        " \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  ",
        "Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)",
    ),
    (
        "nu\u{3042}\"a\":[",
        "Unexpected token '\u{3042}', \"nu\u{3042}\"a\":[\" is not valid JSON",
    ),
    (
        ":{\u{a}  \"",
        "Unexpected token ':', \":{\u{a}  \"\" is not valid JSON",
    ),
    (
        "tru,\u{a}  \"name\": \",\u{a}  \"li",
        "Unexpected token ',', \"tru,\u{a}  \"name\"\"... is not valid JSON",
    ),
    ("[{\"k\":\"v\"},[1,", "Unexpected end of JSON input"),
    (
        "k\":\"v\"},:[1,[2,",
        "Unexpected token 'k', \"k\":\"v\"},:[1,[2,\" is not valid JSON",
    ),
    (
        "tru\"a\":[1,2.5,-3e2,true,",
        "Unexpected string in JSON at position 3 (line 1 column 4)",
    ),
    (
        "0{\"0a\":[1,2.5,-3e2",
        "Unexpected non-whitespace character after JSON at position 1 (line 1 column 2)",
    ),
    (
        "\":[1,2.5,-3e2,true,false,",
        "Unterminated string in JSON at position 25 (line 1 column 26)",
    ),
    (
        " \u{1},a\":[1,2.5,-3e2,true,false,null],\"b\":{\"c\"",
        "Unexpected token '\u{1}', \" \u{1},a\":[1,2.\"... is not valid JSON",
    ),
    (
        "\":[1,2.5,-3e2,true,false,null],\"b\":{\"c\":\"d\\n\\u",
        "Unexpected non-whitespace character after JSON at position 32 (line 1 column 33)",
    ),
    (
        "\"a\":[1,2.52,true,false,null],\"b\":{\"c\":\"d\\n\\u00e9\",\"e\"",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "[{\"k\":\"v\"},[1,[2,[3]],\"\u{e9}",
        "Unterminated string in JSON at position 24 (line 1 column 25)",
    ),
    (
        "\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nested\":",
        "Unexpected non-whitespace character after JSON at position 9 (line 2 column 9)",
    ),
    (
        "[{\"k\":\"v\"}",
        "Expected ',' or ']' after array element in JSON at position 10 (line 1 column 11)",
    ),
    (
        "}{\"a\":[1,2.5,-3e2,true,false,null],\"b",
        "Unexpected token '}', \"}{\"a\":[1,2\"... is not valid JSON",
    ),
    (
        "nul\"a\":[1,2.5",
        "Unexpected string in JSON at position 3 (line 1 column 4)",
    ),
    (
        " \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}",
        "Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)",
    ),
    (
        "\"a\":[1,2.5,-3e2,true,false,null],\"b\":{\"c\":\"d\\",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    ("[{\"k\":\"v\"},[", "Unexpected end of JSON input"),
    (
        " \"name\": \"x\"e,\u{a}  \"list\": [1, 2, 3],\u{a}  \"nested\": {\"t\": true}\u{a}",
        "Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)",
    ),
    (
        "\u{3042}{\"a\":[1,",
        "Unexpected token '\u{3042}', \"\u{3042}{\"a\":[1,\" is not valid JSON",
    ),
    (
        " \"name\": \"x\",\u{a}  \"list\u{a}: [1, 2, nu",
        "Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)",
    ),
    (
        "[{\"k\u{1}\"",
        "Bad control character in string literal in JSON at position 4 (line 1 column 5)",
    ),
    (
        "[{\"k\":\"v\"},[1,[2\",}3",
        "Expected ',' or ']' after array element in JSON at position 16 (line 1 column 17)",
    ),
    (
        "nul\"name\": \"x\",\u{a}  \"list\":nul [1, 2, 3],\u{a}  \"nested\": {\"",
        "Unexpected string in JSON at position 3 (line 1 column 4)",
    ),
    (
        "a\":[1,2.5,-3e2,true,false,nu,l],\"b\":{\"c\":\"d\\n\\u0",
        "Unexpected token 'a', \"a\":[1,2.5,\"... is not valid JSON",
    ),
    (
        " \"name\": \"x\",\u{a}  \"list\": [12, 3],\u{a} ",
        "Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)",
    ),
    (
        "\":",
        "Unterminated string in JSON at position 2 (line 1 column 3)",
    ),
    (
        "x{\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"n",
        "Unexpected token 'x', \"x{\u{a}  \"name\"... is not valid JSON",
    ),
    (
        ":{\u{a}  \"name\":",
        "Unexpected token ':', \":{\u{a}  \"name\":\" is not valid JSON",
    ),
    (
        ",\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nested\": {\"t\": ",
        "Unexpected token ',', \",\u{a}  \"name\"\"... is not valid JSON",
    ),
    (
        "a\":[1,2.5,-3e2",
        "Unexpected token 'a', \"a\":[1,2.5,-3e2\" is not valid JSON",
    ),
    (
        " \"name\": \"x\"},\u{a}  \"list\": ",
        "Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)",
    ),
    (
        "\"a\":[",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "  \"name\": \"x\",\u{a} list\": [1, 2, 3],\u{a}  \"nested\"",
        "Unexpected non-whitespace character after JSON at position 8 (line 1 column 9)",
    ),
    (
        "[{\"k\":\"v\"},[1,[2,[3]]],",
        "Unexpected end of JSON input",
    ),
    (
        ",{\u{a}  \"name\": \"x\",\u{a}  .list\": [1, 2, 3],\u{a}  \"ne{sted\": {\"t\": ",
        "Unexpected token ',', \",{\u{a}  \"name\"... is not valid JSON",
    ),
    (
        "\u{9}[{\"k\":\"v\"},[1,[2,[3]]],\"\u{e9}\u{1f600}\",",
        "Unexpected end of JSON input",
    ),
    (
        "\u{a}{\"a\"\u{a}:[1,2.5,\u{1}-3e2,true,false,null],\"b\":{\"c\":\"",
        "Unexpected token '\u{1}', ...\"\"\u{a}:[1,2.5,\u{1}-3e2,true\"... is not valid JSON",
    ),
    (
        "[{\"k\":\"v,[1,[2,[3]\u{d}\u{a}],\"\u{e9}\u{1f600}\",0.]e",
        "Bad control character in string literal in JSON at position 18 (line 1 column 19)",
    ),
    (
        "\":[1,2.5,-3e2,true,false,n",
        "Unterminated string in JSON at position 26 (line 1 column 27)",
    ),
    (
        "[{\"k\":\"v\"},[,,[2,[3]]],\"\u{1}\u{1f600}\"",
        "Unexpected token ',', ...\"\"k\":\"v\"},[,,[2,[3]]]\"... is not valid JSON",
    ),
    (
        "[{\"k\":\"v\"},[1,[23]]],\"",
        "Unexpected non-whitespace character after JSON at position 20 (line 1 column 21)",
    ),
    (
        "nul\"a\":[1,2.5,-3e2,true,false,null],\"b\":{\"c\":\"d\\n\\u00e",
        "Unexpected string in JSON at position 3 (line 1 column 4)",
    ),
    (
        "[{\"k1\":\"v\"[1,[2,[3]]",
        "Expected ',' or '}' after property value in JSON at position 10 (line 1 column 11)",
    ),
    (
        "{\u{a}  \"name\": \"x\",\u{a}  \"l",
        "Unterminated string in JSON at position 21 (line 3 column 5)",
    ),
    (
        "\u{a}  \"name\": \"x\",\u{a}  ",
        "Unexpected non-whitespace character after JSON at position 9 (line 2 column 9)",
    ),
    (
        "  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3]",
        "Unexpected non-whitespace character after JSON at position 8 (line 1 column 9)",
    ),
    (
        "[{\":",
        "Unterminated string in JSON at position 4 (line 1 column 5)",
    ),
    (
        "[{\"k\":v\"},",
        "Unexpected token 'v', \"[{\"k\":v\"},\" is not valid JSON",
    ),
    (
        " \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nested",
        "Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)",
    ),
    (
        "[{\"kv\"},[1,[2,[3]\u{d}\u{a}]",
        "Expected ':' after property name in JSON at position 6 (line 1 column 7)",
    ),
    (
        "\"]\u{a}  \"name\": \"xe",
        "Bad control character in string literal in JSON at position 2 (line 1 column 3)",
    ),
    (
        "[{\"k\":\"v\"},[1,[2,[3]]],\"\u{e9}\u{1f600}\",00.5e",
        "Unexpected number in JSON at position 30 (line 1 column 31)",
    ),
    (
        ",{\u{a}  \"name\": \"x\",\u{a}  \"list\": ",
        "Unexpected token ',', \",{\u{a}  \"name\"... is not valid JSON",
    ),
    (
        "[{\"k\":\"v\u{9}\"},[1",
        "Bad control character in string literal in JSON at position 8 (line 1 column 9)",
    ),
    (
        "[{\"k\":\"v\"},[1,[2,[3]]],\"\u{a}\u{1f600}\",0.5e-3",
        "Bad control character in string literal in JSON at position 24 (line 1 column 25)",
    ),
    (
        "-{\"",
        "No number after minus sign in JSON at position 1 (line 1 column 2)",
    ),
    (
        "[{\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}",
        "Expected double-quoted property name in JSON at position 39 (line 4 column 1)",
    ),
    (
        "\u{d}\u{a}\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, ",
        "Unexpected non-whitespace character after JSON at position 11 (line 3 column 9)",
    ),
    (
        ":[\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nested\": {\"t\"",
        "Unexpected token ':', \":[\u{a}  \"name\"... is not valid JSON",
    ),
    (
        "\u{a}\\\u{a}  \"",
        "Unexpected token '\\', \"\u{a}\\\u{a}  \"\" is not valid JSON",
    ),
    (
        "\":[1,2.5,-3e2,true,false,null],\"b",
        "Unexpected non-whitespace character after JSON at position 32 (line 1 column 33)",
    ),
    (
        "[{\"",
        "Unterminated string in JSON at position 3 (line 1 column 4)",
    ),
    (
        "\"a\":[1,2.5,-3e2,true,false,null],\"b\":{\"c\":\"d\\n\\u00e9\",\"e\":[",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "{\u{a}  \"neame\": \"x\",\u{a}  \"list\":nul [1, ",
        "Unexpected token ' ', ...\"\"list\":nul [1, \" is not valid JSON",
    ),
    (
        " \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nules",
        "Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)",
    ),
    (
        "\"a\":[1,2.5,-3e2,true,false,null],\"b\":",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "\u{e9}\\\"a\":[1,2.5,-3e2,tr",
        "Unexpected token '\u{e9}', \"\u{e9}\\\"a\":[1,2.5,-3e2,tr\" is not valid JSON",
    ),
    (
        "[{\"k\":\"v},[1,[2,[3]]],\"\u{e9}\u{1f600}\",",
        "Expected ',' or '}' after property value in JSON at position 23 (line 1 column 24)",
    ),
    (
        "\u{1}\\\"a\":[1,2.5,-3e2,true,fa",
        "Unexpected token '\u{1}', \"\u{1}\\\"a\":[1,2\"... is not valid JSON",
    ),
    (
        "[{\"k\":\"v\"},[1,[2,\u{9}3}]],\"\u{e9}\u{1f600}\"",
        "Expected ',' or ']' after array element in JSON at position 19 (line 1 column 20)",
    ),
    (
        "\u{3042}{\u{a}",
        "Unexpected token '\u{3042}', \"\u{3042}{\u{a}\" is not valid JSON",
    ),
    (
        "  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nes",
        "Unexpected non-whitespace character after JSON at position 8 (line 1 column 9)",
    ),
    (
        "[{\"k\":\"v,[1,[2,[3]]],\"\u{e9}\u{1f600}\",0",
        "Expected ',' or '}' after property value in JSON at position 22 (line 1 column 23)",
    ),
    (
        "[{\"k\":\"v\"},[1,[2]]],\"\",",
        "Unexpected non-whitespace character after JSON at position 19 (line 1 column 20)",
    ),
    (
        "  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nested\": {\"t\": ]r",
        "Unexpected non-whitespace character after JSON at position 8 (line 1 column 9)",
    ),
    (
        "\u{1f600}\"a\":[1,2.5,-3e2,true,fa",
        "Unexpected token '\u{fffd}', \"\u{1f600}\"a\":[1,2\"... is not valid JSON",
    ),
    (
        " \"name\": \"x\",\u{a}  \"list\": [1, 2,\u{a}3],\u{a}  \"nest",
        "Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)",
    ),
    (
        "nul-\u{a}  \"name\": \"x\",\u{a} x\"list\": [1, 2, 3],\u{a}  \"nested\": {",
        "Unexpected number in JSON at position 3 (line 1 column 4)",
    ),
    ("[{\"k\":\"v\"},[1,[2,[", "Unexpected end of JSON input"),
    (
        "  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nested\"",
        "Unexpected non-whitespace character after JSON at position 8 (line 1 column 9)",
    ),
    (
        "\u{a}{\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"neste",
        "Unterminated string in JSON at position 47 (line 5 column 9)",
    ),
    (
        "[{\"\"v\"},[1,[2,[3]]],\"-\u{e9}\u{1f600}\u{d}\u{a},0.5e",
        "Expected ':' after property name in JSON at position 4 (line 1 column 5)",
    ),
    (
        "[{\"k",
        "Unterminated string in JSON at position 4 (line 1 column 5)",
    ),
    (
        "[{\"k\":\"v\"},[1,[2,[3]\u{9}]],\"\u{e9}\u{1f600}\",0.",
        "Unterminated fractional number in JSON at position 32 (line 1 column 33)",
    ),
    (
        "\u{9}{\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],]\u{a}  \"nested\": ",
        "Expected double-quoted property name in JSON at position 38 (line 3 column 21)",
    ),
    ("[{\"tru\":", "Unexpected end of JSON input"),
    (
        "a\":[1,2.5,-3e2,true,fals",
        "Unexpected token 'a', \"a\":[1,2.5,\"... is not valid JSON",
    ),
    (
        "\u{3042}{\"k",
        "Unexpected token '\u{3042}', \"\u{3042}{\"k\" is not valid JSON",
    ),
    (
        "[{\"k0:\"v\"},[1,[2,[3]]],\"\u{e9}\u{1f600}\",0.5",
        "Expected ':' after property name in JSON at position 7 (line 1 column 8)",
    ),
    (
        "[{\"k\":\"v\"},[1,[2,[3]]],\"\u{1f600}\u{e9}\u{1f600}\",0.",
        "Unterminated fractional number in JSON at position 33 (line 1 column 34)",
    ),
    ("{\"a\":[1,2.5,", "Unexpected end of JSON input"),
    (
        "\u{9}{\u{a}  \"name\":tru\"x\",\u{a}  \"list\": [1, 2, 3\u{a}  \"nested\"",
        "Unexpected string in JSON at position 15 (line 2 column 13)",
    ),
    (
        "\u{d}\u{a}\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3]",
        "Unexpected non-whitespace character after JSON at position 11 (line 3 column 9)",
    ),
    (
        "\"{\u{a} \\\"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}",
        "Bad control character in string literal in JSON at position 2 (line 1 column 3)",
    ),
    (
        "\u{1f600}\"a\":[1,2.5,-3e2,true,false,null],\"b\":{\"c\":\"d\\",
        "Unexpected token '\u{fffd}', \"\u{1f600}\"a\":[1,2\"... is not valid JSON",
    ),
    (
        "{{\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"",
        "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    ),
    (
        "\"a\":[1,2.5,-3e2,true,",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        ".{\"a\":[1,2.5,-3e2,t",
        "Unexpected token '.', \".{\"a\":[1,2.5,-3e2,t\" is not valid JSON",
    ),
    (
        "{\"",
        "Unterminated string in JSON at position 2 (line 1 column 3)",
    ),
    (
        "tru\u{a}  \"name\":x\",\u{a}  ",
        "Unexpected token '\u{a}', \"tru\u{a}  \"name\":x\",\u{a}  \" is not valid JSON",
    ),
    (
        "[{\"kv\"},[1,[2,[3]]],\"\u{e9}\u{1f600}\",0.5e-3]",
        "Expected ':' after property name in JSON at position 6 (line 1 column 7)",
    ),
    (
        "x{\"a\":[1.5,-3e2,true,lse,null],\"b\":{\"c\":\"d\\n\\u00e9\",\"e\":[]",
        "Unexpected token 'x', \"x{\"a\":[1.5\"... is not valid JSON",
    ),
    (
        "\"{\"a\":[1,2.5,-3e2,true,false,null],\"b\":{\"c\":\"d\\n\\u",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    ("[{\"k\u{e9}\":\"v\"},[1,[", "Unexpected end of JSON input"),
    (
        "x{\"a\":[1,2.5,-3e2,true,false,null],\"b\":{\"c\":\"d\\n\\u00e9\",\"e",
        "Unexpected token 'x', \"x{\"a\":[1,2\"... is not valid JSON",
    ),
    (
        "}{\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nested\": {\"t\"",
        "Unexpected token '}', \"}{\u{a}  \"name\"... is not valid JSON",
    ),
    (
        "\u{1f600}{\"a\":[1,2.5,-3e2,true,fa",
        "Unexpected token '\u{fffd}', \"\u{1f600}{\"a\":[1,\"... is not valid JSON",
    ),
    (
        "a\":[1,",
        "Unexpected token 'a', \"a\":[1,\" is not valid JSON",
    ),
    (
        "  \"name\": \"x\",\u{a}  \"",
        "Unexpected non-whitespace character after JSON at position 8 (line 1 column 9)",
    ),
    (
        "\"a\":[1,2.5,-3e2,true,false,null],\"b\":{\"c\":\"d\\n\\u00e9\"",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "  \"name\": \"x\",\u{a} ",
        "Unexpected non-whitespace character after JSON at position 8 (line 1 column 9)",
    ),
    (
        "e}\"a\":[1,2.5,-3e2,true,false,null],\"b\":{\"c",
        "Unexpected token 'e', \"e}\"a\":[1,2\"... is not valid JSON",
    ),
    (
        "[{\"k\":\"v\"},[1,[2,[3],\"\u{e9}\u{1f600}\",",
        "Unexpected end of JSON input",
    ),
    (
        "\"a\":,1,2.5,-3e2,true,false,null]",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "[{\u{a}  \"name\": \":x\",\u{a}  \"list\": [1, 2, 3]",
        "Expected ',' or '}' after property value in JSON at position 38 (line 3 column 20)",
    ),
    (
        "\"a\":[1,2.5,-3e2",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "}{\u{a} ",
        "Unexpected token '}', \"}{\u{a} \" is not valid JSON",
    ),
    (
        "\u{1f600}{\u{a}  \"name\": \"x\"],\u{a}  \"list\": [1, 2, 3],\u{a}  \"nested\": {\"\\t\": ",
        "Unexpected token '\u{fffd}', \"\u{1f600}{\u{a}  \"nam\"... is not valid JSON",
    ),
    (
        "a\":[1,2.",
        "Unexpected token 'a', \"a\":[1,2.\" is not valid JSON",
    ),
    (
        "[{\"k:\"v\"},[1,[2,[3],",
        "Expected ':' after property name in JSON at position 6 (line 1 column 7)",
    ),
    (
        "\"a\":[1,2.5,-3e2,true,false",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "{{\"a\":[1,2.5,-",
        "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    ),
    (
        "[{\"k\",:\"v\"},[1,[20",
        "Expected ':' after property name in JSON at position 5 (line 1 column 6)",
    ),
    (
        "[{\"k\":\"v\"},[1,[2-[3]]],\"\",",
        "Expected ',' or ']' after array element in JSON at position 16 (line 1 column 17)",
    ),
    (
        "\u{d}\u{a}\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a} ",
        "Unexpected non-whitespace character after JSON at position 11 (line 3 column 9)",
    ),
    (
        "\u{a}-\"a\":[1,2.5,-3e2,true,fal",
        "No number after minus sign in JSON at position 2 (line 2 column 2)",
    ),
    (
        "\"a\":[1,2.5,-3e2,true,false,null],\":{\"c\":\"d\\n",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "\":[1,2.5,-3e2,true,false,null],\"b\":{\"c\":\"d\\n\\u00e9",
        "Unexpected non-whitespace character after JSON at position 32 (line 1 column 33)",
    ),
    (
        "[{\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a} n",
        "Expected double-quoted property name in JSON at position 40 (line 4 column 2)",
    ),
    (
        "[{\"k\":\"v\"},[\u{d}\u{a},[2,",
        "Unexpected token ',', \"[{\"k\":\"v\"},[\u{d}\u{a},[2,\" is not valid JSON",
    ),
    (
        "[{\"k\":\"v[1,[2,[3]]],\"\u{e9}",
        "Expected ',' or '}' after property value in JSON at position 21 (line 1 column 22)",
    ),
    (
        "tru\"a\":[1,2.5,-3e2,tru{,false,null],\"b\":",
        "Unexpected string in JSON at position 3 (line 1 column 4)",
    ),
    (
        "[{\"k\":\"v\"},[1,[2,[3]]],\"\u{e9}\u{1f600}\",0",
        "Expected ',' or ']' after array element in JSON at position 30 (line 1 column 31)",
    ),
    (
        "a\":[1,2.5,-3e2,true,",
        "Unexpected token 'a', \"a\":[1,2.5,-3e2,true,\" is not valid JSON",
    ),
    (
        "{[{\"k\":\"x\"},[1,[2",
        "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    ),
    ("[{\"k\":\"v\"},[1,[", "Unexpected end of JSON input"),
    (
        "[{\"k\":\"v\"},[1,[2,[,\"\u{e9}\u{1f600}\",0.5e-",
        "Unexpected token ',', ...\"\"},[1,[2,[,\"\u{e9}\u{1f600}\",0.5\"... is not valid JSON",
    ),
    (
        "\u{3042}{\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"ne",
        "Unexpected token '\u{3042}', \"\u{3042}{\u{a}  \"name\"... is not valid JSON",
    ),
    (
        ".:{\"a\":[1,2.5,-3e2,true,false,null],\"b\":{\"c\":\"d\\",
        "Unexpected token '.', \".:{\"a\":[1,\"... is not valid JSON",
    ),
    (
        "\u{1}{\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, ",
        "Unexpected token '\u{1}', \"\u{1}{\u{a}  \"name\"... is not valid JSON",
    ),
    (
        "[\u{1f600}\u{a}  \"name\": \"x\",\u{a}  \"list",
        "Unexpected token '\u{fffd}', \"[\u{1f600}\u{a}  \"name\"... is not valid JSON",
    ),
    (
        "\"k\":\"v\"},[1,[2,[3,\"tru\u{e9}\u{1f600}\",",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "[{\"k:\":\"v\"},[11[2",
        "Expected ',' or ']' after array element in JSON at position 15 (line 1 column 16)",
    ),
    (
        "\u{9}{\"a\":[1,2.5,\u{a}3e2,true,false,null],\"b\":{\"c\":\"d\\n",
        "Unterminated string in JSON at position 48 (line 2 column 35)",
    ),
    ("\u{9}{\"a\":", "Unexpected end of JSON input"),
    (
        "[{\"k\":\"v[1,[",
        "Unterminated string in JSON at position 12 (line 1 column 13)",
    ),
    (
        " \"name\": \"x\",\u{a} \u{3042}\"list\": [1, 2, 3],\u{a}  \"nested\": {\"t\": tr",
        "Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)",
    ),
    (
        "  \"n",
        "Unterminated string in JSON at position 4 (line 1 column 5)",
    ),
    (
        "\":[1,2.5,-3e2,true,false,null],\"b\":{\"c\":\"d",
        "Unexpected non-whitespace character after JSON at position 32 (line 1 column 33)",
    ),
    (
        "\u{3042}\"\"a\":[1,2.5,-3e2,true,",
        "Unexpected token '\u{3042}', \"\u{3042}\"\"a\":[1,2\"... is not valid JSON",
    ),
    (
        "\u{d}\u{a}\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  ",
        "Unexpected non-whitespace character after JSON at position 11 (line 3 column 9)",
    ),
    (
        ":{\"a\":[1,2.5,-3e2,true",
        "Unexpected token ':', \":{\"a\":[1,2\"... is not valid JSON",
    ),
    (
        "[{\"k\"",
        "Expected ':' after property name in JSON at position 5 (line 1 column 6)",
    ),
    (
        "]}\"a\":[1,2.5,-3e2,true,false,null],\"b\":{\"c\":\"d\\n\\u00e9",
        "Unexpected token ']', \"]}\"a\":[1,2\"... is not valid JSON",
    ),
    (
        "\"k\":\u{1f600}\"v\"},[nul1,[2,[3]]],\"\u{e9}\u{1f600}\",",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        " \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nested\": {\"t\": ",
        "Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)",
    ),
    (
        "[{\"k\":e\"v[1,[2,[",
        "Unexpected token 'e', \"[{\"k\":e\"v[1,[2,[\" is not valid JSON",
    ),
    (
        "\"a\":[1,2.5,-",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "a\":[1,2.5,-3e2ue,f",
        "Unexpected token 'a', \"a\":[1,2.5,-3e2ue,f\" is not valid JSON",
    ),
    (
        "  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nest",
        "Unexpected non-whitespace character after JSON at position 8 (line 1 column 9)",
    ),
    (
        "{[{\"k\":\"v\"},[1,[",
        "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    ),
    (
        "a\":[\u{d}\u{a}1,2.5,-3e2,true,false,null],\"b\":{\"c\":\"d\\n\\u00e9\",\"e",
        "Unexpected token 'a', \"a\":[\u{d}\u{a}1,2.\"... is not valid JSON",
    ),
    (
        "k\":\"v\"},[1,[2,[3]]",
        "Unexpected token 'k', \"k\":\"v\"},[1,[2,[3]]\" is not valid JSON",
    ),
    (
        "[{\"k\"v\"}\"[1,[2,[3]]],",
        "Expected ':' after property name in JSON at position 5 (line 1 column 6)",
    ),
    (
        "[{\"k\":\"v\"},[[2,[3]]]",
        "Expected ',' or ']' after array element in JSON at position 20 (line 1 column 21)",
    ),
    (
        ":\u{9}{\"k\":\"",
        "Unexpected token ':', \":\u{9}{\"k\":\"\" is not valid JSON",
    ),
    (
        "\u{a}  \"name\":\"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"n",
        "Unexpected non-whitespace character after JSON at position 9 (line 2 column 9)",
    ),
    (
        "tru\"a\":[1,2.5,-3e2,true,false,null",
        "Unexpected string in JSON at position 3 (line 1 column 4)",
    ),
    (
        "\":[1,2.5,-3e2,true,false,null],\"b\":{\"c",
        "Unexpected non-whitespace character after JSON at position 32 (line 1 column 33)",
    ),
    (
        "\u{1f600}{\"a\":[1,2.5,-3e2,t",
        "Unexpected token '\u{fffd}', \"\u{1f600}{\"a\":[1,2.5,-3e2,t\" is not valid JSON",
    ),
    (
        "\u{a}  \"name",
        "Unterminated string in JSON at position 8 (line 2 column 8)",
    ),
    (
        "[{\"k\":\"v\"},[1,[2,[3]\"]],\"\u{e9}",
        "Expected ',' or ']' after array element in JSON at position 20 (line 1 column 21)",
    ),
    (
        "[{\"kx:\"v\"},[1,[2,[3]]],\"\u{e9}\u{1f600}\",",
        "Expected ':' after property name in JSON at position 7 (line 1 column 8)",
    ),
    (
        "  \"name\": \"x\",\u{a}  \"li",
        "Unexpected non-whitespace character after JSON at position 8 (line 1 column 9)",
    ),
    (
        "[{\"k\":\"v\"},[,[2,[3]]],\"\u{e9}]\u{1f600}\",0.5",
        "Unexpected token ',', ...\"\"k\":\"v\"},[,[2,[3]]],\"... is not valid JSON",
    ),
    (
        ".{\"k\":\"v\"},[1,[2,",
        "Unexpected token '.', \".{\"k\":\"v\"},[1,[2,\" is not valid JSON",
    ),
    ("[{\"k\":\"v\"},[1,[tru", "Unexpected end of JSON input"),
    (
        "\u{a}  \"name\": \"x\",\u{a} ",
        "Unexpected non-whitespace character after JSON at position 9 (line 2 column 9)",
    ),
    (
        "\"a\":[1,2.5,-3e2,",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
    (
        "{{\"k\":\"v\"},[1,[2,[3]]],\"\u{3042}\u{1f600}\"",
        "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    ),
    (
        "-{\u{a}  \"name\": \"x\",\u{a}  \"l",
        "No number after minus sign in JSON at position 1 (line 1 column 2)",
    ),
    (
        "[{\"k\":\"v\"},[2,[3]]],\"\u{e9}\u{1f600}\",0.5e-3",
        "Unexpected non-whitespace character after JSON at position 19 (line 1 column 20)",
    ),
    ("[{\"a\":[1,2.5,-3e2,", "Unexpected end of JSON input"),
    (
        "0{\u{a}  \"name\": ",
        "Unexpected non-whitespace character after JSON at position 1 (line 1 column 2)",
    ),
    (
        "x{\"a\":[1,2.5,-3e2,true,false,null],\"b\":{\"c\"",
        "Unexpected token 'x', \"x{\"a\":[1,2\"... is not valid JSON",
    ),
    (
        "\u{1}{\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3],\u{a}  \"nested\"",
        "Unexpected token '\u{1}', \"\u{1}{\u{a}  \"name\"... is not valid JSON",
    ),
    (
        "\u{3042}{\"a\":[1,2.5,-3",
        "Unexpected token '\u{3042}', \"\u{3042}{\"a\":[1,2.5,-3\" is not valid JSON",
    ),
    (
        "{\"[\":\"v\"},[1",
        "Unexpected non-whitespace character after JSON at position 9 (line 1 column 10)",
    ),
    (
        "e\u{e9}\"a\":\u{e9}[1,2.5,-3e2,true,false,null],\"b\":{\"c\":\"d\\n\\u00e9\",\"e\":[",
        "Unexpected token 'e', \"e\u{e9}\"a\":\u{e9}[1,\"... is not valid JSON",
    ),
    (
        "[{\"k[:\"v\"},[1,[2",
        "Expected ':' after property name in JSON at position 7 (line 1 column 8)",
    ),
    (
        "\":\u{a}  \"name\": \"x\",\u{a}  \"list\": [1, 2, 3]",
        "Bad control character in string literal in JSON at position 2 (line 1 column 3)",
    ),
    (
        "\u{d}\u{a}\"a\":[1,2e5,-3e2,tr",
        "Unexpected non-whitespace character after JSON at position 5 (line 2 column 4)",
    ),
    (
        "\"a\":[1,",
        "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)",
    ),
];

#[test]
fn messages_are_nodes() {
    let mut wrong = Vec::new();
    for &(text, expected) in CASES {
        match json_parse(text) {
            Ok(_) => wrong.push(format!("{text:?}: parsed, Node says {expected:?}")),
            Err(error) => {
                if error.message() != expected {
                    wrong.push(format!(
                        "{text:?}\n   got  {:?}\n   node {expected:?}",
                        error.message()
                    ));
                } else {
                    assert_eq!(error.to_string(), format!("SyntaxError: {expected}"));
                }
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "{} of {} differ:\n{}",
        wrong.len(),
        CASES.len(),
        wrong.join("\n")
    );
}
