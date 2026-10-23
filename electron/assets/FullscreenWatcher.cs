// Windows-only foreground/fullscreen observer. No global input hook and no window activation.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
class FullscreenWatcher {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] static extern bool GetMonitorInfo(IntPtr h, ref MonitorInfo info);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder name, int size);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    static volatile string managedHandles = "";
    static int Main(string[] args) {
        int parent; if(args.Length != 1 || !Int32.TryParse(args[0], out parent)) return 2;
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        var input = new Thread(() => { string line; while((line=Console.ReadLine())!=null) managedHandles=line; });
        input.IsBackground=true; input.Start();
        string previous = null;
        while(true) {
            try { if(Process.GetProcessById(parent).HasExited) return 0; } catch(ArgumentException) { return 0; }
            string value = "none";
            IntPtr window = GetForegroundWindow(); uint pid; GetWindowThreadProcessId(window, out pid);
            var name = new StringBuilder(256); GetClassName(window,name,name.Capacity);
            var type=name.ToString();
            if(window != IntPtr.Zero && pid != parent && type != "Progman" && type != "WorkerW" && type != "Shell_TrayWnd" && type != "Shell_SecondaryTrayWnd") {
                Rect rect; var info = new MonitorInfo(); info.Size=Marshal.SizeOf(typeof(MonitorInfo));
                if(GetWindowRect(window,out rect) && GetMonitorInfo(MonitorFromWindow(window,2),ref info) &&
                    rect.Left <= info.Monitor.Left+2 && rect.Top <= info.Monitor.Top+2 &&
                    rect.Right >= info.Monitor.Right-2 && rect.Bottom >= info.Monitor.Bottom-2) {
                    var r=info.Monitor;
                    foreach(var item in managedHandles.Split(' ')) {
                        long raw; if(!Int64.TryParse(item,out raw)) continue;
                        IntPtr managed = new IntPtr(raw);
                        if(MonitorFromWindow(managed,2)==MonitorFromWindow(window,2))
                            SetWindowPos(managed,window,0,0,0,0,0x0013);
                    }
                    value=String.Format("rect {0} {1} {2} {3}",r.Left,r.Top,r.Right-r.Left,r.Bottom-r.Top);
                }
            }
            if(value!=previous) { Console.WriteLine(value); Console.Out.Flush(); previous=value; }
            Thread.Sleep(650);
        }
    }
}
