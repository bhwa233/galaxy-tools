// Read only the foreground selection through Windows UI Automation. No clipboard,
// simulated keys, mouse hooks or background listeners are installed.
using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
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
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    static IntPtr Focus(IntPtr window) {
        uint pid; uint thread=GetWindowThreadProcessId(window,out pid);
        var info=new GuiInfo(); info.Size=Marshal.SizeOf(typeof(GuiInfo));
        return GetGUIThreadInfo(thread,ref info)?info.Focus:IntPtr.Zero;
    }
    static long Identity(uint pid) {
        using(var process=Process.GetProcessById((int)pid)) return process.StartTime.ToUniversalTime().Ticks;
    }
    static bool Modifiers() {
        foreach(int key in new int[] {0x10,0x11,0x12,0x5b,0x5c}) if(GetAsyncKeyState(key)<0) return true;
        return false;
    }
    static List<AutomationElement> SourceAncestors(AutomationElement element,IntPtr window) {
        var ancestors=new List<AutomationElement>(); bool belongs=false;
        for(int i=0;element!=null && i<64;i++) {
            if(element.Current.IsPassword) return null;
            ancestors.Add(element);
            IntPtr handle=new IntPtr(element.Current.NativeWindowHandle);
            if(handle==window) return ancestors;
            if(handle!=IntPtr.Zero && IsChild(window,handle)) belongs=true;
            element=TreeWalker.RawViewWalker.GetParent(element);
        }
        return belongs?ancestors:null;
    }
    // null means this node has no text provider. An empty selection from an
    // actual text provider remains authoritative; never read its whole value.
    static string Selection(AutomationElement element) {
        object pattern;
        if(!element.TryGetCurrentPattern(TextPattern.Pattern,out pattern)) return null;
        var ranges=((TextPattern)pattern).GetSelection();
        if(ranges==null || ranges.Length==0 || ranges.Length>16) return "";
        var text=new StringBuilder();
        foreach(var range in ranges) {
            string part=range.GetText(Limit+1);
            if(part.Length>Limit) return "";
            text.Append(part);
            if(text.Length>Limit || Encoding.UTF8.GetByteCount(text.ToString())>Limit) return "";
        }
        return text.ToString();
    }
    static string SelectedDocument(AutomationElement focused,IntPtr focus,IntPtr window) {
        var ancestors=SourceAncestors(focused,window);
        if(ancestors==null) return "";
        foreach(var element in ancestors) {
            string selected=Selection(element);
            if(selected!=null) return selected;
        }
        // Alt-based hotkeys can leave UIA focus on a menu. The native focus
        // HWND still scopes the active document. Read only visible text
        // providers' selections there, and reject conflicting selections.
        var scope=AutomationElement.FromHandle(focus);
        if(scope==null || SourceAncestors(scope,window)==null) return "";
        string scopedSelection=Selection(scope);
        if(scopedSelection!=null) return scopedSelection;
        var providers=scope.FindAll(TreeScope.Descendants,new AndCondition(
            new PropertyCondition(AutomationElement.IsTextPatternAvailableProperty,true),
            new PropertyCondition(AutomationElement.IsOffscreenProperty,false)));
        if(providers.Count>64) return "";
        string result=null;
        for(int i=0;i<providers.Count;i++) {
            var element=providers[i];
            if(SourceAncestors(element,window)==null) continue;
            string selected=Selection(element);
            if(String.IsNullOrEmpty(selected)) continue;
            if(result!=null && result!=selected) return "";
            result=selected;
        }
        return result??"";
    }
    static string Read(int ownPid, IntPtr target) {
        // The panel may already own the foreground when this read starts, so a
        // caller that sampled the source window beforehand passes it in. Without
        // an explicit target the read stays strictly foreground-scoped.
        IntPtr window=target!=IntPtr.Zero?target:GetForegroundWindow();
        uint pid; GetWindowThreadProcessId(window,out pid);
        if(window==IntPtr.Zero || pid==0 || (int)pid==ownPid) return "";
        if(!IsWindow(window)) return "";
        long identity=Identity(pid);
        // RegisterHotKey fires on keydown. Allow Alt/menu focus to settle while
        // keeping the external source window foreground throughout the read.
        var settling=Stopwatch.StartNew();
        while(Modifiers() && settling.ElapsedMilliseconds<500) {
            if(target==IntPtr.Zero && GetForegroundWindow()!=window) return "";
            Thread.Sleep(10);
        }
        if(target==IntPtr.Zero && GetForegroundWindow()!=window) return "";
        IntPtr focus=Focus(window);
        // Showing the panel hands focus to it, so the source thread may no longer
        // report a focused child. With an explicit target, scan the window itself
        // for the text provider that still holds the selection.
        if(focus==IntPtr.Zero) {
            if(target==IntPtr.Zero) return "";
            focus=window;
        }
        var element=target!=IntPtr.Zero?AutomationElement.FromHandle(focus):AutomationElement.FocusedElement;
        if(element==null) return "";
        string text=SelectedDocument(element,focus,window);
        uint currentPid; GetWindowThreadProcessId(window,out currentPid);
        if(currentPid!=pid || Identity(pid)!=identity || !IsWindow(window)) return "";
        if(target==IntPtr.Zero && (GetForegroundWindow()!=window || Focus(window)!=focus)) return "";
        return text;
    }
    [STAThread] static int Main(string[] args) {
        Console.OutputEncoding=new UTF8Encoding(false);
        Console.InputEncoding=new UTF8Encoding(false);
        int hostPid;
        if(args.Length==2 && args[0]=="--server" && Int32.TryParse(args[1],out hostPid))
            return Serve(hostPid);
        string text=""; int ownPid;
        try { if(args.Length==1 && Int32.TryParse(args[0],out ownPid)) text=Read(ownPid,IntPtr.Zero); } catch { }
        Console.Write(new JavaScriptSerializer {MaxJsonLength=524288}.Serialize(new {text=text}));
        return 0;
    }
    static int Serve(int hostPid) {
        // Bind the helper to this host lifetime, including a host crash while UIA is blocked.
        Process host;
        try { host=Process.GetProcessById(hostPid); } catch { return 1; }
        var lifetime=new Thread(delegate() {
            try { host.WaitForExit(); } catch { }
            Environment.Exit(0);
        });
        lifetime.IsBackground=true;
        lifetime.Start();
        // Pay CLR/UIA initialization once. No external selection is read until requested.
        try { var root=AutomationElement.RootElement; } catch { }
        var serializer=new JavaScriptSerializer {MaxJsonLength=524288};
        Console.WriteLine("{\"ready\":true}");
        Console.Out.Flush();
        string line;
        while((line=Console.ReadLine())!=null) {
            try {
                if(line.Length>4096) return 1;
                var request=serializer.Deserialize<Dictionary<string,object>>(line);
                object idValue,operation,targetValue; Guid id;
                if(request==null || (request.Count!=2 && request.Count!=3)) return 1;
                if(!request.TryGetValue("id",out idValue) || !(idValue is string) ||
                    !Guid.TryParse((string)idValue,out id) ||
                    !request.TryGetValue("operation",out operation)) return 1;
                long target=0;
                if(request.Count==3) {
                    if(!request.TryGetValue("targetWindow",out targetValue)) return 1;
                    try { target=Convert.ToInt64(targetValue); } catch { return 1; }
                }
                if(Object.Equals(operation,"foreground")) {
                    Console.WriteLine(serializer.Serialize(new {id=(string)idValue,window=(long)GetForegroundWindow()}));
                    Console.Out.Flush();
                    continue;
                }
                if(!Object.Equals(operation,"read")) return 1;
                string text="";
                try { text=Read(hostPid,new IntPtr(target)); } catch { }
                Console.WriteLine(serializer.Serialize(new {id=(string)idValue,text=text}));
                Console.Out.Flush();
            } catch { return 1; }
        }
        return 0;
    }
}
