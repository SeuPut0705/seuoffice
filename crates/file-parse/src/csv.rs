//! `decodeCsvBuffer` of packages/xlsx-gateway/src/gateway/csv-import.ts, and
//! what it uses: the bytes of a CSV or TSV attachment as text.
//!
//! The TypeScript decodes with the host's `TextDecoder`; this decodes with
//! `encoding_rs`, which is the WHATWG Encoding Standard. Where Node's decoder
//! differs from the standard, the gate lists the difference as a defect of
//! the TypeScript.

use std::collections::HashSet;
use std::sync::LazyLock;

use encoding_rs::{Encoding, REPLACEMENT, UTF_16BE, UTF_16LE};

/// `LEGACY_CHARSETS`: what Excel writes CSV in outside UTF-8.
const LEGACY_CHARSETS: [&str; 5] = ["gb18030", "shift_jis", "big5", "euc-kr", "windows-1252"];

/// `new TextDecoder(charset, { fatal }).decode(bytes)`, `None` where the
/// constructor throws (a label the standard does not know, or one that names
/// the replacement encoding) or a fatal decoder meets an error. A BOM of the
/// encoding itself is dropped, as `TextDecoder` does unless told not to.
fn decode(bytes: &[u8], charset: &str, fatal: bool) -> Option<String> {
    let encoding = Encoding::for_label(charset.as_bytes()).filter(|found| *found != REPLACEMENT)?;
    let (text, had_errors) = encoding.decode_with_bom_removal(bytes);
    (!(fatal && had_errors)).then(|| text.into_owned())
}

/// The 700 most frequent Hangul syllables in general Korean prose (Korean
/// Wikipedia articles); they cover over 99% of syllables in real text. GBK or
/// Shift_JIS bytes read as EUC-KR also give Hangul, but mostly rare syllables
/// outside this set.
static COMMON_HANGUL: LazyLock<HashSet<char>> = LazyLock::new(|| {
    concat!(
        "이다는의에한로을하가서기은대지고사어으국를인도시년과적수자정구제있부리학교전나일주되해스장역경라었화들원아중만공상계와며성관문동등여그보개선",
        "유식용세비영민위조명회했게터산분치연소면방반거통된울미발음생업재행법월단진육체간드러운우포피종요것였양르할차무당강모신데실작커후오마심프현료",
        "물내트따병표설특남외초야점같른력각타축건권함본또술형출안천립많때준려두류별더래바예록카급입호평금매태근능임크향불추최레목환결약파독루및군노까",
        "합말북속않광배석론열격니직히처았언품판컴퓨달험증키받악활령규곳철디련접질편알존람높메족든확집청복습량늘없감변헌승저졌필던율총토난새항채택럽져",
        "골쓰버팀름측순페코란쟁네박송림탄올날범번린칙참션볼베줄퍼브온창책투견백맞뒤균쳐황패글겨절색쪽농랑담티플효누억객칭넘픽왔득너뜻워께징률왕써갈찰",
        "얻협밀낮탐츠획례앙암벌돌탈테랜념램충큰났검논망혁취응착친밖삼층융잡될완곡궁즈김락갖휘폐킥극널걸넓컵애살럼블침클못맥훈탕꾸케머앞움길찾먹링센떤",
        "므막롯텔잔맹빈잠폭닌런털엔혼봉빌옮손슬잘찬허륙팅몇숙압킨템좌뿐염좋떻풍즉렸빠겼핵촉갔놓느잉웨넷끝희켰덕첫틴볶익윤욱켜먼녹턴잇춘씨팔째퇴긴흐둘",
        "낸홍힘괄둔흔흥몰맛풋휴척릴맡톤렵슈헤렇괴섭쇄혹씩끼콩뉴캐넣섰릉웃뀌렌븐쳤몽밍벨즘벽떨엄섬냉콘돈옥액읍혈떠묘옛헐눈텍숫덜킹렀붙략귀뉘쿠겪촌녀쓴",
        "읽푸틀밝앗랐웠싸값롭뉜갑왜졸랫콜셈킬잎혀룬혜곤슷텐욕랍컨릭큼홈칼얼듬헬셀끌엑님델폴놀십몸칠짓짧춰셔빛좁촬낱삶땅붕맺엇힌빼낙됨썼멘궐죄핑즐돕핸",
        "윈뢰짐룹멸탁겸답뤄싱봄켓굴춤롤곽죽흑쇼냈닥낳핀혔섞샤멀꽃흡듣쉬폰뜨쿨굽뛰옐곧맨됐벗돼빚섯늦컬꼽풀칸밤꺼멈팬앤즌튜낼짜깔렬낀눌깊뚜싼찍빨젠뽑톨",
    )
    .chars()
    .collect()
});

/// `looksKorean`: most characters outside ASCII are Hangul syllables, and
/// most of those are everyday syllables. Chinese or Japanese bytes read as
/// EUC-KR land on hanja, symbols, or rare syllables instead.
pub fn looks_korean(text: &str) -> bool {
    let (mut non_ascii, mut hangul, mut common) = (0u32, 0u32, 0u32);
    for character in text.chars() {
        let code = u32::from(character);
        if code < 0x80 {
            continue;
        }
        non_ascii += 1;
        if !(0xac00..=0xd7a3).contains(&code) {
            continue;
        }
        hangul += 1;
        if COMMON_HANGUL.contains(&character) {
            common += 1;
        }
    }
    hangul >= 6
        && f64::from(hangul) / f64::from(non_ascii) >= 0.8
        && f64::from(common) / f64::from(hangul) >= 0.75
}

/// `score`: how plausible a decoding is; CJK and ASCII good, replacement
/// characters and control bytes bad.
fn score(text: &str) -> i64 {
    let mut value = 0;
    for character in text.chars() {
        let code = u32::from(character);
        value += if character == '\u{fffd}' {
            -20
        } else if code < 0x20 && !matches!(character, '\n' | '\r' | '\t') {
            -10
        } else if code < 0x7f {
            1
        } else if (0xff61..=0xff9f).contains(&code) {
            // half-width katakana is the signature of double-byte text misread
            // as Shift_JIS, and near-absent from real spreadsheets
            -2
        } else if (0x3000..=0x9fff).contains(&code)
            || (0xac00..=0xd7af).contains(&code)
            || (0xff00..=0xffef).contains(&code)
        {
            2
        } else {
            0
        };
    }
    value
}

/// `sniffUtf16WithoutBom`: UTF-16 without a BOM interleaves the text with NUL
/// bytes, which strict UTF-8 accepts, so it is told apart first; the side with
/// more NUL bytes picks the byte order, ties going to little endian.
fn sniff_utf16_without_bom(bytes: &[u8]) -> Option<&'static Encoding> {
    let sample = &bytes[..bytes.len().min(1024)];
    let (mut pairs, mut even_nul, mut odd_nul) = (0u32, 0u32, 0u32);
    for pair in sample.as_chunks::<2>().0 {
        pairs += 1;
        even_nul += u32::from(pair[0] == 0);
        odd_nul += u32::from(pair[1] == 0);
    }
    if pairs < 2 || f64::from(even_nul + odd_nul) / f64::from(pairs * 2) < 0.05 {
        return None;
    }
    Some(if odd_nul >= even_nul {
        UTF_16LE
    } else {
        UTF_16BE
    })
}

/// `decodeCsvBuffer(bytes, preferred)`: a BOM, then UTF-16 without one, then
/// strict UTF-8, then Korean when the bytes are clearly Korean, then the
/// legacy charset whose text scores best. `preferred` is a charset label
/// from the UI language; `None` and `""` both stand for none, as in the
/// TypeScript.
pub fn decode_csv_buffer(bytes: &[u8], preferred: Option<&str>) -> String {
    let decode_or_empty =
        |bytes: &[u8], charset: &str| decode(bytes, charset, false).unwrap_or_default();
    if let Some(rest) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        return decode_or_empty(rest, "utf-8");
    }
    if let Some(rest) = bytes.strip_prefix(&[0xff, 0xfe]) {
        return decode_or_empty(rest, "utf-16le");
    }
    if let Some(rest) = bytes.strip_prefix(&[0xfe, 0xff]) {
        return decode_or_empty(rest, "utf-16be");
    }
    if let Some(encoding) = sniff_utf16_without_bom(bytes) {
        return decode_or_empty(bytes, encoding.name());
    }
    if let Some(utf8) = decode(bytes, "utf-8", true) {
        return utf8;
    }
    let preferred = preferred.filter(|preferred| !preferred.is_empty());

    // Korean Excel CSVs (code page 949) decode as plausible GBK too: pick
    // Korean from the bytes alone, unless the preferred charset reads them
    // cleanly, and only when the text is overwhelmingly Hangul
    if preferred
        .is_none_or(|preferred| preferred == "euc-kr" || decode(bytes, preferred, true).is_none())
        && let Some(korean) = decode(bytes, "euc-kr", true)
        && looks_korean(&korean)
    {
        return korean;
    }

    let mut best = decode_or_empty(bytes, "utf-8");
    let mut best_score = score(&best);
    // CJK-only UTF-16 carries too few NUL bytes for the sniffer; the scorer picks it
    let charsets = ["utf-16le", "utf-16be"]
        .into_iter()
        .chain(preferred)
        .chain(LEGACY_CHARSETS);
    for charset in charsets {
        let Some(candidate) = decode(bytes, charset, false) else {
            continue;
        };
        let candidate_score = score(&candidate);
        if candidate_score > best_score {
            best = candidate;
            best_score = candidate_score;
        }
    }
    best
}
