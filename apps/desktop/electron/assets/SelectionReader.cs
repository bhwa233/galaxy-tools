// Read only the foreground selection through Windows UI Automation. No clipboard,
// simulated keys, mouse hooks or background listeners are installed.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Automation;

class SelectionReader {
    const int Limit = 65536;
    [StructLayout(LayoutKind.Sequential)] struct GuiInfo {
        public int Size; public uint Flags;
        public IntPtr Active, Focus, Capture, Menu, Move, Caret;
        public int Left, Top, Right, Bottom;
    }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo info);
    [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr child);
    static IntPtr Focus(IntPtr window) {
        uint pid; uint thread=GetWindowThreadProcessId(window,out pid);
        var info=new GuiInfo(); info.Size=Marshal.SizeOf(typeof(GuiInfo));
        return GetGUIThreadInfo(thread,ref info)?info.Focus:IntPtr.Zero;
    }
    static long Identity(uint pid) {
        using(var process=Process.GetProcessById((int)pid)) return process.StartTime.ToUniversalTime().Ticks;
    }
    static string Read(int ownPid) {
        IntPtr window=GetForegroundWindow(); uint pid; GetWindowThreadProcessId(window,out pid);
        if(window==IntPtr.Zero || pid==0 || pid==ownPid) return "";
        long identity=Identity(pid); IntPtr focus=Focus(window);
        if(focus==IntPtr.Zero) return "";
        var element=AutomationElement.FocusedElement;
        if(element==null) return "";
        // UIA providers may live in a browser renderer process. Bind the focused
        // element to the actual foreground HWND, not just a matching process ID.
        bool belongs=false;
        var ancestor=element;
        for(int i=0;ancestor!=null && i<64;i++) {
            if(ancestor.Current.IsPassword) return "";
            IntPtr handle=new IntPtr(ancestor.Current.NativeWindowHandle);
            if(handle==window || (handle!=IntPtr.Zero && IsChild(window,handle))) { belongs=true; break; }
            ancestor=TreeWalker.RawViewWalker.GetParent(ancestor);
        }
        if(!belongs) return "";
        object pattern;
        if(!element.TryGetCurrentPattern(TextPattern.Pattern,out pattern)) return "";
        var ranges=((TextPattern)pattern).GetSelection();
        if(ranges==null || ranges.Length==0 || ranges.Length>16) return "";
        var text=new StringBuilder();
        foreach(var range in ranges) {
            string part=range.GetText(Limit+1);
            if(part.Length>Limit) return "";
            text.Append(part);
            if(text.Length>Limit || Encoding.UTF8.GetByteCount(text.ToString())>Limit) return "";
        }
        uint currentPid; GetWindowThreadProcessId(window,out currentPid);
        if(GetForegroundWindow()!=window || Focus(window)!=focus || currentPid!=pid || Identity(pid)!=identity) return "";
        return text.ToString();
    }
    [STAThread] static int Main(string[] args) {
        Console.OutputEncoding=new UTF8Encoding(false);
        string text=""; int ownPid;
        try { if(args.Length==1 && Int32.TryParse(args[0],out ownPid)) text=Read(ownPid); } catch { }
        Console.Write(new JavaScriptSerializer {MaxJsonLength=524288}.Serialize(new {text=text}));
        return 0;
    }
}
