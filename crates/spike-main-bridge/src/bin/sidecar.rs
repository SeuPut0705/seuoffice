//! The sidecar side of the experiment: frames on stdin and stdout,
//! `u32 length (little endian) | kind byte | payload`.
//! Kind 1: JSON call, answered like the Node-API `call`. Kind 2: bytes, echoed.
//! Kind 3: `count` as JSON; the sidecar then asks the parent `count` times
//! (kind 4 out, kind 5 back) and answers with the round trips in microseconds.

use std::io::{self, Read, Write};
use std::time::Instant;

fn read_frame(input: &mut impl Read) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut len = [0u8; 4];
    match input.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len) as usize;
    let mut body = vec![0u8; len];
    input.read_exact(&mut body)?;
    let kind = body[0];
    body.remove(0);
    Ok(Some((kind, body)))
}

fn write_frame(out: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    out.write_all(&((payload.len() + 1) as u32).to_le_bytes())?;
    out.write_all(&[kind])?;
    out.write_all(payload)?;
    out.flush()
}

fn main() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut out = io::stdout().lock();
    while let Some((kind, body)) = read_frame(&mut input)? {
        match kind {
            1 => {
                let request: serde_json::Value = serde_json::from_slice(&body)?;
                let reply = serde_json::json!({ "name": request["name"], "value": request["args"] });
                write_frame(&mut out, 1, reply.to_string().as_bytes())?;
            }
            2 => write_frame(&mut out, 2, &body)?,
            3 => {
                let count: u32 = serde_json::from_slice(&body)?;
                let mut times = Vec::with_capacity(count as usize);
                for i in 0..count {
                    let start = Instant::now();
                    write_frame(&mut out, 4, &i.to_le_bytes())?;
                    match read_frame(&mut input)? {
                        Some((5, _)) => {}
                        _ => return Err(io::Error::other("expected an answer")),
                    }
                    times.push(start.elapsed().as_secs_f64() * 1e6);
                }
                write_frame(&mut out, 3, serde_json::to_string(&times)?.as_bytes())?;
            }
            _ => return Err(io::Error::other("unknown frame kind")),
        }
    }
    Ok(())
}
