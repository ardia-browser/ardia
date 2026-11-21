#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i32)]
pub enum Exit {
    Normal = 0,
    Usage = 64,
    LoadFailed = 70,
    OutOfMemory = 71,
    CpuBudget = 72,
    Stack = 73,
    ChannelClosed = 74,
    ChannelViolated = 75,
    SandboxSetup = 76,
    ShutdownDeadline = 77,
    TurnWatchdog = 78,
}

impl Exit {
    pub fn code(self) -> i32 {
        self as i32
    }

    pub fn reason(self) -> &'static str {
        match self {
            Exit::Normal => "normal",
            Exit::Usage => "usage",
            Exit::LoadFailed => "loadFailed",
            Exit::OutOfMemory => "overMemory",
            Exit::CpuBudget => "cpuBudget",
            Exit::Stack => "stack",
            Exit::ChannelClosed => "channelClosed",
            Exit::ChannelViolated => "channelViolated",
            Exit::SandboxSetup => "sandboxSetup",
            Exit::ShutdownDeadline => "shutdownDeadline",
            Exit::TurnWatchdog => "turnWatchdog",
        }
    }

    pub fn from_code(code: i32) -> Option<Exit> {
        [
            Exit::Normal,
            Exit::Usage,
            Exit::LoadFailed,
            Exit::OutOfMemory,
            Exit::CpuBudget,
            Exit::Stack,
            Exit::ChannelClosed,
            Exit::ChannelViolated,
            Exit::SandboxSetup,
            Exit::ShutdownDeadline,
            Exit::TurnWatchdog,
        ]
        .into_iter()
        .find(|exit| exit.code() == code)
    }
}
