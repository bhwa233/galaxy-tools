// Per-window DWM policy only. Never changes the user's system animation setting.
using System;
using System.Runtime.InteropServices;
class WindowTransitions {
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr window, uint attribute, ref int value, uint size);
    static int Main(string[] args) {
        long handle; uint expected;
        if(args.Length != 2 || !Int64.TryParse(args[0], out handle) || !UInt32.TryParse(args[1], out expected)) return 2;
        var window = new IntPtr(handle);
        uint actual; GetWindowThreadProcessId(window, out actual);
        if(actual == 0 || actual != expected) return 3;
        int disabled = 1;
        // DWMWA_TRANSITIONS_FORCEDISABLED preserves the frame, shadow and resize grips.
        return DwmSetWindowAttribute(window, 3, ref disabled, 4) < 0 ? 4 : 0;
    }
}
