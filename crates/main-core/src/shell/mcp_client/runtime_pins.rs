//! `apps/shell/src/main/mcp-client/runtime-pins.ts`: the runtimes the app may
//! download for the person's own MCP servers, pinned per app release. A
//! version and its SHA-256 change only together, in code. The sources the
//! TypeScript names (nodejs.org dist index and SHASUMS256, the uv release
//! assets, uv's download-metadata for CPython) hold for these constants too.
//!
//! `MCP_RUNTIME_PINS` is a constant object in the TypeScript; its URLs are
//! template strings, so here it is [`mcp_runtime_pins`], called when read.
//! The record keyed by platform is a [`PlatformTable`] whose fields follow the
//! literal's key order. Sizes are `u64`.

/// `McpRuntimePlatformKey`: the OS and chip pairs the app pins a download for
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpRuntimePlatformKey {
    Win32X64,
    DarwinArm64,
    DarwinX64,
    LinuxX64,
}

impl McpRuntimePlatformKey {
    pub fn as_str(self) -> &'static str {
        match self {
            McpRuntimePlatformKey::Win32X64 => "win32-x64",
            McpRuntimePlatformKey::DarwinArm64 => "darwin-arm64",
            McpRuntimePlatformKey::DarwinX64 => "darwin-x64",
            McpRuntimePlatformKey::LinuxX64 => "linux-x64",
        }
    }
}

/// `MCP_RUNTIME_PLATFORM_KEYS`
pub const MCP_RUNTIME_PLATFORM_KEYS: [McpRuntimePlatformKey; 4] = [
    McpRuntimePlatformKey::Win32X64,
    McpRuntimePlatformKey::DarwinArm64,
    McpRuntimePlatformKey::DarwinX64,
    McpRuntimePlatformKey::LinuxX64,
];

/// `Record<McpRuntimePlatformKey, T>`
#[derive(Debug, Clone, PartialEq)]
pub struct PlatformTable<T> {
    pub win32_x64: T,
    pub darwin_arm64: T,
    pub darwin_x64: T,
    pub linux_x64: T,
}

impl<T> PlatformTable<T> {
    /// `table[key]`
    pub fn get(&self, key: McpRuntimePlatformKey) -> &T {
        match key {
            McpRuntimePlatformKey::Win32X64 => &self.win32_x64,
            McpRuntimePlatformKey::DarwinArm64 => &self.darwin_arm64,
            McpRuntimePlatformKey::DarwinX64 => &self.darwin_x64,
            McpRuntimePlatformKey::LinuxX64 => &self.linux_x64,
        }
    }
}

/// `PinnedArchive['format']`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    Zip,
    TarGz,
}

impl ArchiveFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            ArchiveFormat::Zip => "zip",
            ArchiveFormat::TarGz => "tar.gz",
        }
    }
}

/// `PinnedArchive`
#[derive(Debug, Clone, PartialEq)]
pub struct PinnedArchive {
    pub url: String,
    /// lowercase hex SHA-256 of the archive
    pub sha256: String,
    /// exact archive size in bytes; a longer download is cut off and refused
    pub bytes: u64,
    pub format: ArchiveFormat,
    /// the archive's top folder, removed when unpacking ('' when the files sit at the top)
    pub root: String,
}

/// `PinnedRuntime`
#[derive(Debug, Clone, PartialEq)]
pub struct PinnedRuntime {
    pub version: String,
    pub archives: PlatformTable<PinnedArchive>,
}

/// `PinnedPython`
#[derive(Debug, Clone, PartialEq)]
pub struct PinnedPython {
    /// the CPython version `uv python install` is asked for
    pub version: String,
    /// approximate download size per platform, for the question
    pub bytes: PlatformTable<u64>,
}

/// `McpRuntimePins`
#[derive(Debug, Clone, PartialEq)]
pub struct McpRuntimePins {
    pub node: PinnedRuntime,
    pub uv: PinnedRuntime,
    pub python: PinnedPython,
}

const NODE_VERSION: &str = "26.13.0";
const UV_VERSION: &str = "0.13.6";

fn archive(
    url: String,
    sha256: &str,
    bytes: u64,
    format: ArchiveFormat,
    root: &str,
) -> PinnedArchive {
    PinnedArchive {
        url,
        sha256: sha256.to_owned(),
        bytes,
        format,
        root: root.to_owned(),
    }
}

/// `MCP_RUNTIME_PINS`
pub fn mcp_runtime_pins() -> McpRuntimePins {
    let node_dist = format!("https://nodejs.org/dist/v{NODE_VERSION}");
    let uv_dist = format!("https://github.com/astral-sh/uv/releases/download/{UV_VERSION}");
    McpRuntimePins {
        node: PinnedRuntime {
            version: NODE_VERSION.to_owned(),
            archives: PlatformTable {
                win32_x64: archive(
                    format!("{node_dist}/node-v{NODE_VERSION}-win-x64.zip"),
                    "dcc60d59a0746999f99064a01c020445d54d84228c691cdbf25b49ac3b59150a",
                    41_157_375,
                    ArchiveFormat::Zip,
                    &format!("node-v{NODE_VERSION}-win-x64"),
                ),
                darwin_arm64: archive(
                    format!("{node_dist}/node-v{NODE_VERSION}-darwin-arm64.tar.gz"),
                    "d38bd5e5a2ddce6bbb5ce45e46e208337da4d51fffe611e567fd32073d6439f6",
                    58_334_661,
                    ArchiveFormat::TarGz,
                    &format!("node-v{NODE_VERSION}-darwin-arm64"),
                ),
                darwin_x64: archive(
                    format!("{node_dist}/node-v{NODE_VERSION}-darwin-x64.tar.gz"),
                    "525c9b29bb0263d687de60a4cec0e2a6db876a8eb032369e5795eca71e7c358e",
                    59_802_926,
                    ArchiveFormat::TarGz,
                    &format!("node-v{NODE_VERSION}-darwin-x64"),
                ),
                linux_x64: archive(
                    format!("{node_dist}/node-v{NODE_VERSION}-linux-x64.tar.gz"),
                    "5848553868b402d3fabb5b09270649977780a390f832155721025a08b5104455",
                    62_893_692,
                    ArchiveFormat::TarGz,
                    &format!("node-v{NODE_VERSION}-linux-x64"),
                ),
            },
        },
        uv: PinnedRuntime {
            version: UV_VERSION.to_owned(),
            archives: PlatformTable {
                win32_x64: archive(
                    format!("{uv_dist}/uv-x86_64-pc-windows-msvc.zip"),
                    "a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f",
                    15_239_500,
                    ArchiveFormat::Zip,
                    "",
                ),
                darwin_arm64: archive(
                    format!("{uv_dist}/uv-aarch64-apple-darwin.tar.gz"),
                    "60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472",
                    14_235_670,
                    ArchiveFormat::TarGz,
                    "uv-aarch64-apple-darwin",
                ),
                darwin_x64: archive(
                    format!("{uv_dist}/uv-x86_64-apple-darwin.tar.gz"),
                    "63ba17fdda55ad1a230d4b37fc6017ffa10c23688c83818bd3bfdf914c652a02",
                    17_004_934,
                    ArchiveFormat::TarGz,
                    "uv-x86_64-apple-darwin",
                ),
                linux_x64: archive(
                    format!("{uv_dist}/uv-x86_64-unknown-linux-gnu.tar.gz"),
                    "f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645",
                    16_799_024,
                    ArchiveFormat::TarGz,
                    "uv-x86_64-unknown-linux-gnu",
                ),
            },
        },
        python: PinnedPython {
            version: "3.13.18".to_owned(),
            bytes: PlatformTable {
                win32_x64: 22_023_022,
                darwin_arm64: 25_265_774,
                darwin_x64: 25_055_263,
                linux_x64: 35_395_906,
            },
        },
    }
}

/// `mcpRuntimePlatformKey(platform, arch)`: the pinned key for this OS and
/// chip, or `None` when the app pins nothing for it
pub fn mcp_runtime_platform_key(platform: &str, arch: &str) -> Option<McpRuntimePlatformKey> {
    let key = format!("{platform}-{arch}");
    MCP_RUNTIME_PLATFORM_KEYS
        .into_iter()
        .find(|k| k.as_str() == key)
}
