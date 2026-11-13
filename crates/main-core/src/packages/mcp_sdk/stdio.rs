//! `@modelcontextprotocol/sdk` 1.32.1 `shared/stdio.js`: the framing of MCP
//! over a pipe. A message is one line of JSON ended by `\n` (a `\r` before it
//! is dropped); [`ReadBuffer`] cuts the lines out of what the pipe delivers
//! and refuses to hold more than 10 MiB.
//!
//! Driving it, as `ChildProcessTransport` of `mcp-client/local.ts` does: on a
//! chunk of stdout call [`ReadBuffer::append`] (an `Err` is the `onerror` of
//! the transport, and the buffer is empty again), then call
//! [`ReadBuffer::read_message`] until it answers `Ok(None)`. An `Err` there is
//! also `onerror`; the line it failed on is gone, so the loop goes on with
//! the next one. Each message goes to `Client::on_message`. A message to the
//! server is written as [`serialize_message`] gives it.

use jscompat::{JsonSyntaxError, JsonValue, json_parse, json_stringify};

use super::types::schema::{self, Issue};

/// `STDIO_DEFAULT_MAX_BUFFER_SIZE`
pub const STDIO_DEFAULT_MAX_BUFFER_SIZE: usize = 10 * 1024 * 1024;

/// What the framing throws.
#[derive(Debug, Clone, PartialEq)]
pub enum StdioError {
    /// `append`: the buffer would hold more than the maximum
    Overflow { max: usize },
    /// `JSON.parse` of the line
    Json(JsonSyntaxError),
    /// `JSONRPCMessageSchema.parse` of what the line held
    Schema(Vec<Issue>),
}

impl StdioError {
    /// `error.name`
    pub fn name(&self) -> &'static str {
        match self {
            StdioError::Overflow { .. } => "Error",
            StdioError::Json(_) => "SyntaxError",
            StdioError::Schema(_) => "ZodError",
        }
    }

    /// `error.message`
    pub fn message(&self) -> String {
        match self {
            StdioError::Overflow { max } => {
                format!("ReadBuffer exceeded maximum size of {max} bytes")
            }
            StdioError::Json(error) => error.message().to_owned(),
            StdioError::Schema(issues) => schema::error_message(issues),
        }
    }
}

/// `ReadBuffer`: bytes in, parsed messages out
#[derive(Debug, Default)]
pub struct ReadBuffer {
    /// `None` is `undefined` (nothing buffered yet, or cleared)
    buffer: Option<Vec<u8>>,
    /// where the unread bytes of `buffer` begin
    start: usize,
    max_buffer_size: Option<usize>,
}

impl ReadBuffer {
    /// `new ReadBuffer()`
    pub fn new() -> Self {
        ReadBuffer::default()
    }

    /// `new ReadBuffer({ maxBufferSize })`
    pub fn with_max_buffer_size(max_buffer_size: usize) -> Self {
        ReadBuffer {
            buffer: None,
            start: 0,
            max_buffer_size: Some(max_buffer_size),
        }
    }

    fn max(&self) -> usize {
        self.max_buffer_size
            .unwrap_or(STDIO_DEFAULT_MAX_BUFFER_SIZE)
    }

    /// `append(chunk)`
    pub fn append(&mut self, chunk: &[u8]) -> Result<(), StdioError> {
        let held = self.buffer.as_ref().map_or(0, |b| b.len() - self.start);
        if held + chunk.len() > self.max() {
            self.clear();
            return Err(StdioError::Overflow { max: self.max() });
        }
        match &mut self.buffer {
            Some(buffer) => {
                if self.start > 0 {
                    buffer.drain(..self.start);
                    self.start = 0;
                }
                buffer.extend_from_slice(chunk);
            }
            None => self.buffer = Some(chunk.to_vec()),
        }
        Ok(())
    }

    /// `readMessage()`: `Ok(None)` is `null`. The line is taken off the
    /// buffer before it is parsed, so a line that does not parse is lost.
    pub fn read_message(&mut self) -> Result<Option<JsonValue>, StdioError> {
        let Some(buffer) = &self.buffer else {
            return Ok(None);
        };
        let unread = &buffer[self.start..];
        let Some(index) = unread.iter().position(|byte| *byte == b'\n') else {
            return Ok(None);
        };
        let decoded = String::from_utf8_lossy(&unread[..index]).into_owned();
        let line = decoded.strip_suffix('\r').unwrap_or(&decoded).to_owned();
        self.start += index + 1;
        deserialize_message(&line).map(Some)
    }

    /// `clear()`
    pub fn clear(&mut self) {
        self.buffer = None;
        self.start = 0;
    }
}

/// `deserializeMessage(line)`
pub fn deserialize_message(line: &str) -> Result<JsonValue, StdioError> {
    let parsed = json_parse(line).map_err(StdioError::Json)?;
    schema::safe_parse(&schema::jsonrpc_message(), &parsed).map_err(StdioError::Schema)
}

/// `serializeMessage(message)`: `JSON.stringify(message) + '\n'`
pub fn serialize_message(message: &JsonValue) -> String {
    let mut line = json_stringify(message);
    line.push('\n');
    line
}
