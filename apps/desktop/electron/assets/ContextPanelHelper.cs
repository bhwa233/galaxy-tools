// Observe-only context capture. Every hook event continues to the original application.
// Reuses the in-box .NET compiler/Win32 pattern of FullscreenWatcher; UI Automation,
// clipboard ownership and input cleanup require this small Windows-only boundary.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

class ContextPanelHelper {
    const int FrameLimit = 262144, TextLimit = 65536, ImageLimit = 8388608;
    static readonly object Gate = new object(), OutputGate = new object();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = FrameLimit, RecursionLimit = 12 };
    static string session, spool, fixturePath;
    static Process parent;
    static Control dispatcher;
    static volatile bool stopping;
    static int helperPid;
    static long lastTrigger;
    static bool enabled, copyFallback;
    static string button = "middle";
    static int holdMs = 500, generation;
    static string[] exclusions = new string[0];
    static IntPtr mouseHook;
    static HookProc mouseProc = Mouse;
    static Source held, queued;
    static long downTime;
    static Point downPoint;
    static readonly Dictionary<string, Source> Sources = new Dictionary<string, Source>();
    static CaptureJob active;
    static Dictionary<string, object> fixture;
    class Source {
        public string Token, Created, App;
        public IntPtr Window, Focus;
        public uint Pid;
        public long Expires;
        public Point Point;
        public bool Fixture;
    }
    class CaptureJob {
        public string Id;
        public int Generation;
        public volatile bool Cancelled;
    }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MouseData { public Point Point; public uint Data, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct GuiInfo { public int Size; public uint Flags; public IntPtr Active, Focus, Capture, Menu, Move, Caret; public int L,T,R,B; }
    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public InputUnion Data; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public KeyInput Key; [FieldOffset(0)] public MouseInput Mouse; }
    [StructLayout(LayoutKind.Sequential)] struct KeyInput { public ushort Key, Scan; public uint Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X,Y; public uint Data,Flags,Time; public UIntPtr Extra; }
    delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo info);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out FileTime created, out FileTime exit, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] static extern IntPtr GetClipboardOwner();
    [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr window);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
    [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr memory);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern uint DragQueryFile(IntPtr drop, uint index, StringBuilder file, uint size);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] inputs, int size);
    static long Now { get { return Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency; } }
    static bool Uuid(string value) { Guid id; return value != null && value.Length == 36 && Guid.TryParseExact(value, "D", out id); }
    static string Str(Dictionary<string, object> value, string key) { object result; return value.TryGetValue(key, out result) ? result as string : null; }
    static int Number(Dictionary<string, object> value, string key, int fallback) { object result; return value.TryGetValue(key, out result) && result is int ? (int)result : fallback; }
    static bool Flag(Dictionary<string, object> value, string key) { object result; return value.TryGetValue(key, out result) && result is bool && (bool)result; }
    static Dictionary<string, object> Obj(object value) { return value as Dictionary<string, object>; }
    static object None(string reason) { return new { kind = "none", reason = reason }; }
    static void Send(object value) { lock(OutputGate) {
        string line=Json.Serialize(value);
        if(Encoding.UTF8.GetByteCount(line)>FrameLimit) { Environment.Exit(2); return; }
        Console.WriteLine(line); Console.Out.Flush();
    } }
    static void Reply(string id, object value) { Send(new { v = 1, sessionId = session, type = "response", requestId = id, result = value }); }
    static string Identity(uint pid) {
        IntPtr process = OpenProcess(0x1000, false, pid);
        if(process == IntPtr.Zero) return null;
        try { FileTime a,b,c,d; return GetProcessTimes(process,out a,out b,out c,out d) ? a.High.ToString("x8") + a.Low.ToString("x8") : null; }
        finally { CloseHandle(process); }
    }
    static string App(uint pid) {
        IntPtr process = OpenProcess(0x1000, false, pid);
        if(process == IntPtr.Zero) return null;
        try { var name = new StringBuilder(32768); int size = name.Capacity; return QueryFullProcessImageName(process,0,name,ref size) ? name.ToString() : null; }
        finally { CloseHandle(process); }
    }
    static IntPtr Focus(IntPtr window) {
        uint pid; uint thread = GetWindowThreadProcessId(window,out pid);
        var info = new GuiInfo(); info.Size = Marshal.SizeOf(typeof(GuiInfo));
        return thread != 0 && GetGUIThreadInfo(thread,ref info) ? info.Focus : IntPtr.Zero;
    }
    static Source Current(Point point) {
        IntPtr window = GetForegroundWindow(); uint pid; GetWindowThreadProcessId(window,out pid);
        if(window == IntPtr.Zero || pid == 0 || pid == parent.Id || pid == helperPid) return null;
        string created = Identity(pid); IntPtr focus = Focus(window);
        return created == null || focus == IntPtr.Zero ? null : new Source { Window=window, Focus=focus, Pid=pid, Created=created, Point=point };
    }
    static bool Valid(Source source, bool focus) {
        if(source == null || Now > source.Expires || Identity(source.Pid) != source.Created) return false;
        if(source.Fixture) return true;
        uint pid; GetWindowThreadProcessId(source.Window,out pid);
        return IsWindow(source.Window) && pid == source.Pid && (!focus || (GetForegroundWindow() == source.Window && Focus(source.Window) == source.Focus));
    }
    static bool Modifiers() { foreach(int key in new int[] { 0x10,0x11,0x12,0x5b,0x5c }) if(GetAsyncKeyState(key)<0) return true; return false; }
    static IntPtr Mouse(int code, IntPtr message, IntPtr raw) {
        if(code >= 0 && enabled) {
            var data = (MouseData)Marshal.PtrToStructure(raw,typeof(MouseData));
            if((data.Flags & 1) == 0) {
                int msg = message.ToInt32();
                bool down = button == "middle" ? msg == 0x207 : msg == 0x20b && (data.Data >> 16) == (button == "x1" ? 1u : 2u);
                bool up = button == "middle" ? msg == 0x208 : msg == 0x20c && (data.Data >> 16) == (button == "x1" ? 1u : 2u);
                if(down) { held = Modifiers() ? null : Current(data.Point); downPoint=data.Point; downTime=Now; }
                else if(up) {
                    var source=held; held=null;
                    if(source != null && Now-downTime >= holdMs && !Modifiers() && source.Window==GetForegroundWindow() && source.Focus==Focus(source.Window) && Identity(source.Pid)==source.Created) queued=source;
                } else if(msg == 0x200) {
                    var drag=SystemInformation.DragSize;
                    if(Math.Abs((long)data.Point.X-downPoint.X)>Math.Max(2,drag.Width/2) || Math.Abs((long)data.Point.Y-downPoint.Y)>Math.Max(2,drag.Height/2)) held=null;
                } else held=null;
            }
        }
        return CallNextHookEx(mouseHook,code,message,raw);
    }
    static void Trigger(Source source) {
        if(source == null || !enabled || Now-lastTrigger<200) return;
        string app = source.Fixture ? "fixture.exe" : App(source.Pid);
        if(String.IsNullOrEmpty(app)) return;
        foreach(string excluded in exclusions) if(String.Equals(excluded,app,StringComparison.OrdinalIgnoreCase) || String.Equals(excluded,Path.GetFileName(app),StringComparison.OrdinalIgnoreCase)) return;
        lastTrigger=Now; source.App=Path.GetFileName(app); source.Token=Guid.NewGuid().ToString("D"); source.Expires=Now+30000;
        if(!Valid(source,true)) return;
        lock(Gate) {
            if(Sources.Count>=16) Sources.Clear();
            Sources[source.Token]=source;
        }
        Send(new {v=1,sessionId=session,type="trigger",sourceToken=source.Token,sourceApp=source.App,point=new{x=source.Point.X,y=source.Point.Y}});
    }
    static void Unhook() {
        held=null; queued=null;
        if(mouseHook!=IntPtr.Zero) { UnhookWindowsHookEx(mouseHook); mouseHook=IntPtr.Zero; }
    }
    static void Configure(Dictionary<string,object> cfg) {
        enabled=false; Unhook(); generation++;
        lock(Gate) { Sources.Clear(); if(active!=null) active.Cancelled=true; }
        button=Str(cfg,"button") ?? "middle"; holdMs=Math.Max(0,Math.Min(2000,Number(cfg,"holdMs",500))); copyFallback=Flag(cfg,"copyFallback");
        var list=new List<string>(); object raw;
        if(cfg.TryGetValue("excludedApps",out raw) && raw is IEnumerable) foreach(object entry in (IEnumerable)raw) if(entry is string && ((string)entry).Length<=512 && list.Count<100) list.Add((string)entry);
        exclusions=list.ToArray(); enabled=Flag(cfg,"enabled");
        if(enabled && fixture==null) {
            mouseHook=SetWindowsHookEx(14,mouseProc,GetModuleHandle(null),0);
            if(mouseHook==IntPtr.Zero) { enabled=false; Unhook(); throw new InvalidOperationException(); }
        }
    }
    static bool Alive(CaptureJob job, Source source) { return !stopping && !job.Cancelled && job.Generation==generation && enabled && Valid(source,true); }
    // Null means UIA cannot supply a selection. Empty selection is an authoritative
    // 'none', so Ctrl+C cannot accidentally capture an editor's current line.
    static object Uia(Source source) {
        AutomationElement element=AutomationElement.FocusedElement;
        if(element==null || element.Current.ProcessId!=source.Pid || element.Current.IsPassword) return None("protectedSource");
        object pattern;
        if(!element.TryGetCurrentPattern(TextPattern.Pattern,out pattern)) return null;
        var ranges=((TextPattern)pattern).GetSelection();
        if(ranges==null || ranges.Length==0) return None("emptySelection");
        if(ranges.Length>16) return None("tooLarge");
        var text=new StringBuilder();
        foreach(var range in ranges) { string part=range.GetText(TextLimit+1); if(part.Length>TextLimit) return None("tooLarge"); text.Append(part); if(Encoding.UTF8.GetByteCount(text.ToString())>TextLimit) return None("tooLarge"); }
        return text.Length==0 ? None("emptySelection") : (object)new {kind="text",text=text.ToString(),sourceToken=source.Token,sourceApp=source.App,method="uia"};
    }
    static bool ClipboardSource(Source source,uint sequence) {
        if(sequence==0 || GetClipboardSequenceNumber()!=sequence || !Valid(source,true)) return false;
        uint pid; GetWindowThreadProcessId(GetClipboardOwner(),out pid);
        return pid==source.Pid && Identity(pid)==source.Created;
    }
    static bool Sensitive() {
        foreach(string name in new string[]{"ExcludeClipboardContentFromMonitorProcessing","Clipboard Viewer Ignore"}) if(IsClipboardFormatAvailable(RegisterClipboardFormat(name))) return true;
        uint history=RegisterClipboardFormat("CanIncludeInClipboardHistory");
        if(IsClipboardFormatAvailable(history)) {var data=Memory(history,1024); if(data==null || data.Length<4 || BitConverter.ToUInt32(data,0)==0) return true;}
        return false;
    }
    static byte[] Memory(uint format,int limit) {
        IntPtr handle=GetClipboardData(format); if(handle==IntPtr.Zero) return null;
        ulong length=GlobalSize(handle).ToUInt64(); if(length==0 || length>(ulong)limit) return null;
        IntPtr pointer=GlobalLock(handle); if(pointer==IntPtr.Zero) return null;
        try { var bytes=new byte[(int)length]; Marshal.Copy(pointer,bytes,0,bytes.Length); return bytes; }
        finally { GlobalUnlock(handle); }
    }
    static object ReadClipboard(Source source,CaptureJob job,uint sequence) {
        for(int tries=0;tries<15;tries++) {
            if(!Alive(job,source) || !ClipboardSource(source,sequence)) return None("sourceChanged");
            if(OpenClipboard(IntPtr.Zero)) {
                try {
                    if(!ClipboardSource(source,sequence) || Sensitive()) return None("protectedSource");
                    object result=None("unsupported");
                    if(IsClipboardFormatAvailable(15)) {
                        IntPtr drop=GetClipboardData(15); uint count=DragQueryFile(drop,0xffffffff,null,0);
                        if(count==0 || count>100) return None("tooLarge");
                        var paths=new List<string>(); int total=0;
                        for(uint i=0;i<count;i++) { uint length=DragQueryFile(drop,i,null,0); if(length==0 || length>32767 || (total+=(int)length)>65536) return None("tooLarge"); var name=new StringBuilder((int)length+1); DragQueryFile(drop,i,name,(uint)name.Capacity); paths.Add(name.ToString()); }
                        result=new{kind="files",paths=paths.ToArray(),sourceToken=source.Token,sourceApp=source.App,method="clipboard"};
                    } else if(IsClipboardFormatAvailable(13)) {
                        var bytes=Memory(13,TextLimit*2+2); if(bytes==null || bytes.Length%2!=0) return None("tooLarge");
                        string text=Encoding.Unicode.GetString(bytes); int end=text.IndexOf('\0'); if(end<0) return None("unsupported"); text=text.Substring(0,end);
                        if(Encoding.UTF8.GetByteCount(text)>TextLimit) return None("tooLarge");
                        result=text.Length==0 ? None("emptySelection") : (object)new{kind="text",text=text,sourceToken=source.Token,sourceApp=source.App,method="clipboard"};
                    } else if(IsClipboardFormatAvailable(8) || IsClipboardFormatAvailable(17)) {
                        var dib=Memory(IsClipboardFormatAvailable(8)?8u:17u,ImageLimit); if(dib==null || dib.Length<40) return None("tooLarge");
                        int header=BitConverter.ToInt32(dib,0), width=BitConverter.ToInt32(dib,4), height=BitConverter.ToInt32(dib,8);
                        int bits=BitConverter.ToUInt16(dib,14); uint compression=BitConverter.ToUInt32(dib,16), colors=BitConverter.ToUInt32(dib,32);
                        if((bits!=1 && bits!=4 && bits!=8 && bits!=16 && bits!=24 && bits!=32) || BitConverter.ToUInt16(dib,12)!=1 || (compression==3 && bits!=16 && bits!=32) || header<40 || header>124 || width<=0 || width>8192 || height==0 || Math.Abs((long)height)>8192 || (long)width*Math.Abs((long)height)>16777216 || (compression!=0 && compression!=3)) return None("tooLarge");
                        long offset=14L+header+(header==40 && compression==3?12:0)+(colors>0?colors*4L:bits<=8?(1L<<bits)*4:0);
                        if(offset>dib.Length+14 || offset<54) return None("unsupported");
                        using(var stream=new MemoryStream()) {
                            using(var writer=new BinaryWriter(stream,Encoding.UTF8,true)) { writer.Write((ushort)0x4d42); writer.Write(dib.Length+14); writer.Write(0); writer.Write((int)offset); writer.Write(dib); }
                            stream.Position=0;
                            using(var image=new Bitmap(stream)) {
                                string file=Path.Combine(spool,"image-"+job.Id+".png");
                                using(var output=new MemoryStream()) { image.Save(output,ImageFormat.Png); if(output.Length>ImageLimit) return None("tooLarge"); using(var target=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.None)) { output.Position=0;output.CopyTo(target);target.Flush(true); } }
                                result=new{kind="image",file=file,bytes=new FileInfo(file).Length,sourceToken=source.Token,sourceApp=source.App,method="clipboard"};
                            }
                        }
                    }
                    return Alive(job,source) && ClipboardSource(source,sequence) ? result : None("sourceChanged");
                } finally { CloseClipboard(); }
            }
            Thread.Sleep(15);
        }
        return None("clipboardBusy");
    }
    static Input Key(ushort key,bool up) { return new Input {Type=1,Data=new InputUnion {Key=new KeyInput {Key=key,Flags=up?2u:0u,Extra=new UIntPtr(0x53504350)}}}; }
    static object Copy(Source source,CaptureJob job) {
        if(!Alive(job,source) || Modifiers() || GetAsyncKeyState(0x43)<0) return None("inputBusy");
        uint before=GetClipboardSequenceNumber(); if(before==0) return None("clipboardUnavailable");
        var input=new Input[]{Key(0x11,false),Key(0x43,false),Key(0x43,true),Key(0x11,true)};
        uint sent=SendInput(4,input,Marshal.SizeOf(typeof(Input)));
        if(sent!=4) {
            // Only keys inserted by our incomplete batch need releasing. Never
            // release a key that was already physically held before the batch.
            var cleanup=new List<Input>(); if(sent>=2 && sent<3) cleanup.Add(Key(0x43,true)); if(sent>=1 && sent<4) cleanup.Add(Key(0x11,true));
            if(cleanup.Count>0) SendInput((uint)cleanup.Count,cleanup.ToArray(),Marshal.SizeOf(typeof(Input)));
            return None("inputRejected");
        }
        for(int i=0;i<40;i++) {
            if(!Alive(job,source)) return None("cancelled");
            uint sequence=GetClipboardSequenceNumber();
            if(sequence!=0 && sequence!=before) return ClipboardSource(source,sequence)?ReadClipboard(source,job,sequence):None("clipboardOwnerChanged");
            Thread.Sleep(15);
        }
        return None("clipboardUnchanged");
    }
    static object FixtureCapture(Source source,CaptureJob job) {
        int delay=Math.Max(0,Math.Min(10000,Number(fixture,"delayMs",0)));
        for(int i=0;i<delay;i+=10) { if(!Alive(job,source)) return None("cancelled"); Thread.Sleep(10); }
        if(!Alive(job,source)) return None("sourceChanged");
        string imageFile=Str(fixture,"imageFile");
        if(imageFile!=null) {
            if(Path.GetFileName(imageFile)!=imageFile) return None("unavailable");
            string from=Path.Combine(Path.GetDirectoryName(spool),imageFile);
            var info=new FileInfo(from);
            if(!info.Exists || info.Length==0 || info.Length>ImageLimit || (info.Attributes&FileAttributes.ReparsePoint)!=0) return None("tooLarge");
            string file=Path.Combine(spool,"image-"+job.Id+".png");File.Copy(from,file,false);
            return new{kind="image",file=file,bytes=info.Length,sourceToken=source.Token,sourceApp=source.App,method="clipboard"};
        }
        string text=Str(fixture,"text");
        if(text==null) return None("emptySelection");
        return Encoding.UTF8.GetByteCount(text)>TextLimit?None("tooLarge"):(object)new{kind="text",text=text,sourceToken=source.Token,sourceApp=source.App,method="uia"};
    }
    static void Capture(string id,string token) {
        Source source; CaptureJob job;
        lock(Gate) {
            if(active!=null) { Reply(id,None("busy")); return; }
            if(!enabled || !Sources.TryGetValue(token ?? "",out source) || !Valid(source,true)) { Reply(id,None("sourceChanged")); return; }
            job=new CaptureJob { Id=id,Generation=generation }; active=job;
        }
        var thread=new Thread(()=> {
            object result=None("unavailable");
            try {
                foreach(string file in Directory.GetFiles(spool,"image-*.png")) File.Delete(file);
                if(fixture!=null) result=FixtureCapture(source,job);
                else {
                    try { result=Uia(source); } catch { result=None("unavailable"); }
                    if(result==null) result=copyFallback?Copy(source,job):None("unsupported");
                }
                if(!Alive(job,source)) result=None(job.Cancelled?"cancelled":"sourceChanged");
            } catch { result=None("unavailable"); }
            lock(Gate) { if(active==job) active=null; }
            if(!stopping) Reply(id,result);
        });
        thread.IsBackground=true; thread.SetApartmentState(ApartmentState.STA); thread.Start();
    }
    static object Restore(string token) {
        Source source;
        lock(Gate) if(!Sources.TryGetValue(token ?? "",out source)) return new{ok=false,reason="sourceChanged"};
        if(!Valid(source,false)) return new{ok=false,reason="sourceChanged"};
        if(source.Fixture) return new{ok=true};
        uint pid; GetWindowThreadProcessId(GetForegroundWindow(),out pid);
        if(pid!=parent.Id && GetForegroundWindow()!=source.Window) return new{ok=false,reason="focusChanged"};
        if(!SetForegroundWindow(source.Window) || GetForegroundWindow()!=source.Window || Focus(source.Window)!=source.Focus) return new{ok=false,reason="focusChanged"};
        return new{ok=true};
    }
    static void Command(Dictionary<string,object> command) {
        string id=Str(command,"requestId"), type=Str(command,"type");
        if(Number(command,"v",0)!=1 || Str(command,"sessionId")!=session || !Uuid(id)) throw new InvalidDataException();
        if(type=="init" || type=="update") {
            var cfg=Obj(command.ContainsKey("config")?command["config"]:null); if(cfg==null) throw new InvalidDataException();
            Configure(cfg); Reply(id,new{ok=true});
            if(fixture!=null && enabled) {
                uint pid=(uint)Number(fixture,"sourcePid",parent.Id); string created=Identity(pid);
                if(created!=null) Trigger(new Source {Pid=pid,Created=created,Fixture=true,Point=new Point {X=10,Y=20}});
            }
        } else if(type=="capture") Capture(id,Str(command,"sourceToken"));
        else if(type=="restore") Reply(id,Restore(Str(command,"sourceToken")));
        else if(type=="cancel") { lock(Gate) if(active!=null && active.Id==Str(command,"cancelId")) active.Cancelled=true; Reply(id,new{ok=true}); }
        else if(type=="stop") { Reply(id,new{ok=true}); Exit(); }
        else throw new InvalidDataException();
    }
    static void Exit() { stopping=true; enabled=false; generation++; Unhook(); lock(Gate) {Sources.Clear();if(active!=null)active.Cancelled=true;} Application.ExitThread(); }
    [STAThread] static int Main(string[] args) {
        try {
            Console.InputEncoding=new UTF8Encoding(false,true); Console.OutputEncoding=new UTF8Encoding(false,true);
            helperPid=Process.GetCurrentProcess().Id;
            int parentId;
            if(args.Length<3 || !Int32.TryParse(args[0],out parentId) || !Uuid(args[1])) return 2;
            parent=Process.GetProcessById(parentId); var started=parent.StartTime;
            session=args[1]; spool=Path.GetFullPath(args[2]); Directory.CreateDirectory(spool);
            if((File.GetAttributes(spool)&FileAttributes.ReparsePoint)!=0) return 2;
            if(args.Length==5 && args[3]=="--fixture") {
                fixturePath=Path.GetFullPath(args[4]);
                if(!fixturePath.StartsWith(Path.GetDirectoryName(spool)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase) || (File.GetAttributes(fixturePath)&FileAttributes.ReparsePoint)!=0 || new FileInfo(fixturePath).Length>FrameLimit) return 2;
                fixture=Obj(Json.DeserializeObject(File.ReadAllText(fixturePath,new UTF8Encoding(false,true)))); if(fixture==null) return 2;
            } else if(args.Length!=3) return 2;
            if(fixture==null) SetProcessDpiAwarenessContext(new IntPtr(-4));
            dispatcher=new Control(); dispatcher.CreateControl(); IntPtr handle=dispatcher.Handle;
            var input=new Thread(()=> {
                try {
                    var line=new StringBuilder(); int ch;
                    while((ch=Console.In.Read())>=0) {
                        if(ch=='\n') { string value=line.ToString();line.Length=0; var command=Obj(new JavaScriptSerializer {MaxJsonLength=FrameLimit,RecursionLimit=12}.DeserializeObject(value)); if(command==null)throw new InvalidDataException(); dispatcher.BeginInvoke((Action)(()=>{try{Command(command);}catch{Exit();}})); }
                        else if(ch!='\r') { if(line.Length>=FrameLimit)throw new InvalidDataException();line.Append((char)ch); }
                    }
                } catch { }
                try { dispatcher.BeginInvoke((Action)Exit); } catch { }
            }); input.IsBackground=true;input.Start();
            var timer=new System.Windows.Forms.Timer();timer.Interval=25; timer.Tick+=(s,e)=> {
                if(parent.HasExited) {Exit();return;}
                if(held!=null && (Modifiers() || GetAsyncKeyState(0x1b)<0)) held=null;
                if(queued!=null) {var source=queued;queued=null;Trigger(source);}
                lock(Gate) {var expired=new List<string>();foreach(var item in Sources)if(Now>item.Value.Expires)expired.Add(item.Key);foreach(string key in expired)Sources.Remove(key);}
            };timer.Start();
            Send(new{v=1,sessionId=session,type="ready"}); Application.Run(); timer.Stop();
            return 0;
        } catch {return 2;}
        finally {stopping=true;Unhook();try{if(spool!=null)foreach(string file in Directory.GetFiles(spool,"image-*.png"))File.Delete(file);}catch{}}
    }
}
