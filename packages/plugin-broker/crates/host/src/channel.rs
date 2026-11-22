use std::io;
use std::os::fd::RawFd;

pub const MAX_INCOMING_LINE: usize = 32 << 20;
pub const MAX_OUTGOING_LINE: usize = (1 << 20) - 1;
pub const MAX_PENDING_OUTPUT: usize = 16 << 20;
const READ_CHUNK: usize = 64 << 10;
pub const MAX_LINES_PER_READ: usize = 256;
pub const MAX_BYTES_PER_READ: usize = 1 << 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendRefusal {
    TooLong,
    HasNewline,
    BackedUp,
    Closed,
}

impl SendRefusal {
    pub fn message(self) -> &'static str {
        match self {
            SendRefusal::TooLong => "a line to Ardia is at most 1 MB",
            SendRefusal::HasNewline => "a line to Ardia can't contain a newline",
            SendRefusal::BackedUp => "Ardia isn't reading, so the line was dropped",
            SendRefusal::Closed => "the channel to Ardia is closed",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Overflow {
    LineTooLong,
}

#[derive(Default)]
pub struct LineBuffer {
    pending: Vec<u8>,
    start: usize,
    scanned: usize,
}

impl LineBuffer {
    pub fn push(&mut self, bytes: &[u8]) {
        if self.start > 0 && self.start * 2 >= self.pending.len() {
            self.pending.drain(..self.start);
            self.scanned -= self.start;
            self.start = 0;
        }
        self.pending.extend_from_slice(bytes);
    }

    pub fn next_line(&mut self) -> Result<Option<String>, Overflow> {
        loop {
            let Some(offset) = self.pending[self.scanned..].iter().position(|&b| b == b'\n') else {
                self.scanned = self.pending.len();
                if self.buffered() > MAX_INCOMING_LINE {
                    return Err(Overflow::LineTooLong);
                }
                return Ok(None);
            };
            let end = self.scanned + offset;
            if end - self.start > MAX_INCOMING_LINE {
                return Err(Overflow::LineTooLong);
            }
            let line = &self.pending[self.start..end];
            let text = (!line.is_empty()).then(|| String::from_utf8_lossy(line).into_owned());
            self.start = end + 1;
            self.scanned = self.start;
            if let Some(text) = text {
                return Ok(Some(text));
            }
        }
    }

    pub fn has_line(&self) -> bool {
        self.pending[self.scanned..].contains(&b'\n')
    }

    pub fn buffered(&self) -> usize {
        self.pending.len() - self.start
    }

    pub fn push_and_take(&mut self, bytes: &[u8], lines: &mut Vec<String>) -> Result<(), Overflow> {
        self.push(bytes);
        while let Some(line) = self.next_line()? {
            lines.push(line);
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct Outbox {
    bytes: Vec<u8>,
    sent: usize,
}

impl Outbox {
    pub fn pending(&self) -> usize {
        self.bytes.len() - self.sent
    }

    pub fn queue(&mut self, line: &str) -> Result<(), SendRefusal> {
        let bytes = line.as_bytes();
        if bytes.len() > MAX_OUTGOING_LINE {
            return Err(SendRefusal::TooLong);
        }
        if bytes.iter().any(|&b| b == b'\n' || b == b'\r') {
            return Err(SendRefusal::HasNewline);
        }
        if self.pending() + bytes.len() >= MAX_PENDING_OUTPUT {
            return Err(SendRefusal::BackedUp);
        }
        if self.sent > 0 && self.sent * 2 >= self.bytes.len() {
            self.bytes.drain(..self.sent);
            self.sent = 0;
        }
        self.bytes.extend_from_slice(bytes);
        self.bytes.push(b'\n');
        Ok(())
    }

    pub fn unsent(&self) -> &[u8] {
        &self.bytes[self.sent..]
    }

    pub fn advance(&mut self, count: usize) {
        self.sent += count;
        if self.sent == self.bytes.len() {
            self.bytes.clear();
            self.sent = 0;
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ReadOutcome {
    Open,
    Closed,
    Violated,
}

pub struct Channel {
    fd: RawFd,
    incoming: LineBuffer,
    outgoing: Outbox,
    closed: bool,
    ended: bool,
}

fn errno() -> i32 {
    io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

impl Channel {
    pub fn new(fd: RawFd) -> Channel {
        Channel { fd, incoming: LineBuffer::default(), outgoing: Outbox::default(), closed: false, ended: false }
    }

    pub fn fd(&self) -> RawFd {
        self.fd
    }

    pub fn open(&mut self) -> io::Result<()> {
        unsafe {
            let flags = libc::fcntl(self.fd, libc::F_GETFL);
            if flags < 0 || libc::fcntl(self.fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::fcntl(self.fd, libc::F_SETFD, libc::FD_CLOEXEC) < 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    pub fn wants_write(&self) -> bool {
        !self.closed && self.outgoing.pending() > 0
    }

    pub fn send(&mut self, line: &str) -> Option<SendRefusal> {
        if self.closed {
            return Some(SendRefusal::Closed);
        }
        if let Err(refusal) = self.outgoing.queue(line) {
            return Some(refusal);
        }
        self.flush();
        None
    }

    pub fn flush(&mut self) {
        while !self.closed && self.outgoing.pending() > 0 {
            let unsent = self.outgoing.unsent();
            let count = unsafe { libc::write(self.fd, unsent.as_ptr().cast(), unsent.len()) };
            if count > 0 {
                self.outgoing.advance(count as usize);
                continue;
            }
            let error = errno();
            if count < 0 && error == libc::EINTR {
                continue;
            }
            if count < 0 && (error == libc::EAGAIN || error == libc::EWOULDBLOCK) {
                return;
            }
            self.closed = true;
        }
    }

    pub fn has_buffered_input(&self) -> bool {
        !self.closed && (self.ended || self.incoming.has_line())
    }

    pub fn read_lines(&mut self, lines: &mut Vec<String>) -> ReadOutcome {
        self.read_bounded(lines, MAX_LINES_PER_READ, MAX_BYTES_PER_READ)
    }

    pub fn read_bounded(&mut self, lines: &mut Vec<String>, max_lines: usize, max_bytes: usize) -> ReadOutcome {
        let mut chunk = vec![0u8; READ_CHUNK.min(max_bytes.max(1))];
        let mut read = 0;
        loop {
            if self.closed {
                return ReadOutcome::Closed;
            }
            while lines.len() < max_lines {
                match self.incoming.next_line() {
                    Ok(Some(line)) => lines.push(line),
                    Ok(None) => break,
                    Err(Overflow::LineTooLong) => {
                        self.closed = true;
                        return ReadOutcome::Violated;
                    }
                }
            }
            if lines.len() >= max_lines {
                return ReadOutcome::Open;
            }
            if self.ended {
                self.closed = true;
                return ReadOutcome::Closed;
            }
            if read >= max_bytes {
                return ReadOutcome::Open;
            }
            let want = chunk.len().min(max_bytes - read);
            let count = unsafe { libc::read(self.fd, chunk.as_mut_ptr().cast(), want) };
            if count > 0 {
                self.incoming.push(&chunk[..count as usize]);
                read += count as usize;
                continue;
            }
            let error = errno();
            if count < 0 && error == libc::EINTR {
                continue;
            }
            if count < 0 && (error == libc::EAGAIN || error == libc::EWOULDBLOCK) {
                return ReadOutcome::Open;
            }
            self.ended = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines_of(buffer: &mut LineBuffer, input: &[u8]) -> Vec<String> {
        let mut lines = Vec::new();
        buffer.push_and_take(input, &mut lines).unwrap();
        lines
    }

    #[test]
    fn splits_on_newlines_and_skips_empty_lines() {
        let mut buffer = LineBuffer::default();
        assert_eq!(lines_of(&mut buffer, b"a\n\nb\n"), vec!["a", "b"]);
        assert_eq!(buffer.buffered(), 0);
    }

    #[test]
    fn holds_a_partial_line_until_its_newline() {
        let mut buffer = LineBuffer::default();
        assert!(lines_of(&mut buffer, b"{\"id\":").is_empty());
        assert!(lines_of(&mut buffer, b"1,").is_empty());
        assert_eq!(lines_of(&mut buffer, b"\"x\":2}\nnext"), vec!["{\"id\":1,\"x\":2}"]);
        assert_eq!(buffer.buffered(), 4);
    }

    #[test]
    fn keeps_carriage_returns_like_the_swift_host() {
        let mut buffer = LineBuffer::default();
        assert_eq!(lines_of(&mut buffer, b"a\r\n"), vec!["a\r"]);
    }

    #[test]
    fn replaces_invalid_utf8_with_replacement_characters() {
        let mut buffer = LineBuffer::default();
        assert_eq!(lines_of(&mut buffer, b"a\xffb\n"), vec!["a\u{fffd}b"]);
        assert_eq!(lines_of(&mut buffer, b"\xe2\x82\n"), vec!["\u{fffd}"]);
    }

    #[test]
    fn a_split_multibyte_character_survives_chunking() {
        let mut buffer = LineBuffer::default();
        assert!(lines_of(&mut buffer, b"\xe2\x82").is_empty());
        assert_eq!(lines_of(&mut buffer, b"\xac\n"), vec!["\u{20ac}"]);
    }

    #[test]
    fn refuses_a_line_over_32_mb() {
        let mut buffer = LineBuffer::default();
        let mut lines = Vec::new();
        let block = vec![b'x'; 1 << 20];
        for _ in 0..32 {
            buffer.push_and_take(&block, &mut lines).unwrap();
        }
        assert_eq!(buffer.push_and_take(b"x", &mut lines), Err(Overflow::LineTooLong));
    }

    #[test]
    fn a_32_mb_line_with_its_newline_is_accepted() {
        let mut buffer = LineBuffer::default();
        let mut lines = Vec::new();
        let mut line = vec![b'x'; MAX_INCOMING_LINE];
        line.push(b'\n');
        buffer.push_and_take(&line, &mut lines).unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].len(), MAX_INCOMING_LINE);
    }

    #[test]
    fn an_oversized_line_is_refused_even_when_its_newline_arrives_in_the_same_chunk() {
        let mut buffer = LineBuffer::default();
        let mut lines = Vec::new();
        let mut line = vec![b'x'; MAX_INCOMING_LINE + 1];
        line.extend_from_slice(b"\nnext\n");
        assert_eq!(buffer.push_and_take(&line, &mut lines), Err(Overflow::LineTooLong));
        assert!(lines.is_empty());
    }

    #[test]
    fn an_oversized_line_split_across_chunks_with_a_trailing_newline_is_refused() {
        let mut buffer = LineBuffer::default();
        let mut lines = Vec::new();
        buffer.push_and_take(b"ok\n", &mut lines).unwrap();
        for _ in 0..32 {
            buffer.push(&vec![b'x'; 1 << 20]);
        }
        buffer.push(b"x\n");
        assert_eq!(buffer.next_line(), Err(Overflow::LineTooLong));
        assert_eq!(lines, vec!["ok"]);
    }

    fn pair() -> (Channel, Channel) {
        let mut fds = [0; 2];
        assert_eq!(unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) }, 0);
        let mut a = Channel::new(fds[0]);
        let mut b = Channel::new(fds[1]);
        a.open().unwrap();
        b.open().unwrap();
        (a, b)
    }

    fn write_all(fd: RawFd, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            let count = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
            assert!(count > 0);
            bytes = &bytes[count as usize..];
        }
    }

    #[test]
    fn one_read_takes_at_most_256_lines_and_keeps_the_rest_buffered() {
        let (mut host, peer) = pair();
        write_all(peer.fd(), "a\n".repeat(1000).as_bytes());
        let mut lines = Vec::new();
        assert_eq!(host.read_lines(&mut lines), ReadOutcome::Open);
        assert_eq!(lines.len(), MAX_LINES_PER_READ);
        assert!(host.has_buffered_input());
        let mut total = lines.len();
        for _ in 0..10 {
            lines.clear();
            host.read_lines(&mut lines);
            total += lines.len();
        }
        assert_eq!(total, 1000);
        assert!(!host.has_buffered_input());
        unsafe { libc::close(host.fd()) };
        unsafe { libc::close(peer.fd()) };
    }

    #[test]
    fn one_read_takes_at_most_1_mb_from_the_socket() {
        let mut fds = [0; 2];
        assert_eq!(unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) }, 0);
        let mut host = Channel::new(fds[0]);
        host.open().unwrap();
        let peer = Channel::new(fds[1]);
        let writer = std::thread::spawn({
            let fd = peer.fd();
            move || write_all(fd, &vec![b'z'; 3 << 20])
        });
        let mut lines = Vec::new();
        let mut reads = 0;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while host.incoming.buffered() < 3 << 20 {
            assert!(std::time::Instant::now() < deadline, "only {} bytes arrived", host.incoming.buffered());
            let before = host.incoming.buffered();
            assert_eq!(host.read_lines(&mut lines), ReadOutcome::Open);
            assert!(host.incoming.buffered() - before <= MAX_BYTES_PER_READ);
            reads += 1;
            if host.incoming.buffered() == before {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
        writer.join().unwrap();
        assert!(reads >= 3);
        assert!(lines.is_empty());
        unsafe { libc::close(host.fd()) };
        unsafe { libc::close(peer.fd()) };
    }

    #[test]
    fn lines_before_eof_are_delivered_before_the_close() {
        let (mut host, peer) = pair();
        write_all(peer.fd(), "x\n".repeat(300).as_bytes());
        unsafe { libc::close(peer.fd()) };
        let mut lines = Vec::new();
        assert_eq!(host.read_lines(&mut lines), ReadOutcome::Open);
        assert_eq!(lines.len(), 256);
        assert!(host.has_buffered_input());
        lines.clear();
        assert_eq!(host.read_lines(&mut lines), ReadOutcome::Closed);
        assert_eq!(lines.len(), 44);
        unsafe { libc::close(host.fd()) };
    }

    #[test]
    fn outgoing_limits_match_the_swift_host() {
        let mut outbox = Outbox::default();
        assert_eq!(outbox.queue(&"x".repeat(MAX_OUTGOING_LINE)), Ok(()));
        assert_eq!(outbox.queue(&"x".repeat(MAX_OUTGOING_LINE + 1)), Err(SendRefusal::TooLong));
        assert_eq!(outbox.queue("a\nb"), Err(SendRefusal::HasNewline));
        assert_eq!(outbox.queue("a\rb"), Err(SendRefusal::HasNewline));
        assert_eq!(outbox.unsent().len(), MAX_OUTGOING_LINE + 1);
    }

    #[test]
    fn outgoing_backs_up_at_16_mb_pending() {
        let mut outbox = Outbox::default();
        let line = "y".repeat(MAX_OUTGOING_LINE);
        let mut queued = 0;
        while outbox.queue(&line).is_ok() {
            queued += 1;
        }
        assert_eq!(queued, 16);
        assert_eq!(outbox.queue(&line), Err(SendRefusal::BackedUp));
        assert_eq!(outbox.pending(), MAX_PENDING_OUTPUT);
        outbox.advance(outbox.pending());
        assert_eq!(outbox.pending(), 0);
        assert_eq!(outbox.queue(&line), Ok(()));
    }

    #[test]
    fn refusal_messages_match_the_swift_host() {
        assert_eq!(SendRefusal::TooLong.message(), "a line to Ardia is at most 1 MB");
        assert_eq!(SendRefusal::HasNewline.message(), "a line to Ardia can't contain a newline");
        assert_eq!(SendRefusal::BackedUp.message(), "Ardia isn't reading, so the line was dropped");
        assert_eq!(SendRefusal::Closed.message(), "the channel to Ardia is closed");
    }

    #[test]
    fn socketpair_round_trip_with_partial_writes() {
        let mut fds = [0; 2];
        assert_eq!(unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) }, 0);
        let mut host = Channel::new(fds[0]);
        host.open().unwrap();
        let big = "z".repeat(MAX_OUTGOING_LINE);
        for _ in 0..4 {
            assert_eq!(host.send(&big), None);
        }
        assert!(host.wants_write());
        let mut peer = Channel::new(fds[1]);
        peer.open().unwrap();
        let mut got = Vec::new();
        for _ in 0..10_000 {
            host.flush();
            peer.read_lines(&mut got);
            if got.len() == 4 {
                break;
            }
        }
        assert_eq!(got.len(), 4);
        assert!(got.iter().all(|line| line.len() == MAX_OUTGOING_LINE));
        assert!(!host.wants_write());
        unsafe { libc::close(fds[1]) };
        let mut after = Vec::new();
        assert_eq!(host.read_lines(&mut after), ReadOutcome::Closed);
        assert_eq!(host.send("x"), Some(SendRefusal::Closed));
        unsafe { libc::close(fds[0]) };
    }
}
