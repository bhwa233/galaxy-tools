// Explorer-owned child windows. No topmost overlay, input hook or activation.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

class DesktopTrigger {
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    delegate bool EnumWindow(IntPtr window, IntPtr value);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr value);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr window, int index, int value);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr window, ref Point point);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(Point point, uint flags);
    [DllImport("Shcore.dll")] static extern int GetScaleFactorForMonitor(IntPtr monitor, out int scale);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out NativeRect rect);
    [StructLayout(LayoutKind.Sequential)] struct NativeRect { public int Left, Top, Right, Bottom; }
    static volatile bool enabled = false;
    static volatile bool inputEnded = false;

    static bool DesktopRoot(IntPtr root) {
        if(root == IntPtr.Zero || !IsWindow(root)) return false;
        var name = new StringBuilder(256);
        GetClassName(root, name, name.Capacity);
        if(name.ToString() != "Progman" && name.ToString() != "WorkerW") return false;
        uint pid; GetWindowThreadProcessId(root, out pid);
        try { using(var process = Process.GetProcessById((int)pid)) return process.ProcessName == "explorer"; }
        catch(ArgumentException) { return false; }
    }
    static IntPtr DesktopView(IntPtr root) {
        return DesktopRoot(root) ? FindWindowEx(root, IntPtr.Zero, "SHELLDLL_DefView", null) : IntPtr.Zero;
    }
    static IntPtr DesktopHost() {
        IntPtr found = DesktopView(FindWindow("Progman", null));
        if(found != IntPtr.Zero) return found;
        EnumWindows((window, value) => {
            // Explorer folder windows also contain SHELLDLL_DefView. Only the
            // desktop's Progman/WorkerW may own this non-activating child.
            found = DesktopView(window);
            return found == IntPtr.Zero;
        }, IntPtr.Zero);
        return found;
    }
    static int Scale(Screen screen) {
        int scale;
        var center = new Point(screen.Bounds.Left + screen.Bounds.Width / 2, screen.Bounds.Top + screen.Bounds.Height / 2);
        if(GetScaleFactorForMonitor(MonitorFromPoint(center, 2), out scale) != 0 || scale < 100 || scale > 500)
            throw new InvalidOperationException("Cannot determine desktop trigger display scale");
        return scale;
    }
    static Rectangle TriggerBounds(Screen screen, int scale) {
        int width = 120 * scale / 100, height = 8 * scale / 100, gap = Math.Max(2, 2 * scale / 100);
        // The work area leaves a docked taskbar above the trigger. An auto-hide
        // taskbar's screen-edge activation strip stays above the small gap.
        var area = screen.WorkingArea;
        return new Rectangle(area.Left + (area.Width - width) / 2, area.Top + gap, width, height);
    }
    class Trigger : Form {
        readonly ToolTip tip = new ToolTip();
        readonly IntPtr parent;
        public Rectangle TargetBounds { get; private set; }
        public bool Attached {
            get {
                return !IsDisposed && IsHandleCreated && IsWindow(Handle) && IsWindow(parent) &&
                    GetParent(Handle) == parent && DesktopRoot(GetParent(parent)) &&
                    (GetWindowLong(Handle, -16) & 0x40000000) != 0 &&
                    (GetWindowLong(Handle, -20) & 0x00000008) == 0;
            }
        }
        public Trigger(IntPtr desktop, Screen screen, int scale) {
            parent = desktop;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Color.FromArgb(110, 115, 120);
            TargetBounds = TriggerBounds(screen, scale);
            var origin = TargetBounds.Location;
            if(!ScreenToClient(parent, ref origin)) throw new InvalidOperationException("Desktop trigger coordinates unavailable");
            var handle = Handle;
            SetWindowLong(handle, -16, (GetWindowLong(handle, -16) | 0x40000000) & ~unchecked((int)0x80000000));
            SetParent(handle, parent);
            // SetParent may fail or reset DPI awareness across processes. A
            // failed bind must never fall back to a visible top-level window.
            if(!Attached || !SetWindowPos(handle, IntPtr.Zero, origin.X, origin.Y, TargetBounds.Width, TargetBounds.Height, 0x0010)) {
                Dispose();
                throw new InvalidOperationException("Desktop trigger could not bind to Explorer");
            }
            tip.SetToolTip(this, Environment.GetEnvironmentVariable("SPARK233_TRIGGER_LABEL") ?? "Open card desktop");
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams {
            get { var value = base.CreateParams; value.ExStyle |= 0x08000080; return value; }
        }
        protected override void OnMouseClick(MouseEventArgs e) {
            base.OnMouseClick(e);
            if(e.Button != MouseButtons.Left || !enabled || !Attached) return;
            var point = PointToScreen(new Point(e.X, e.Y));
            Console.WriteLine("click " + point.X + " " + point.Y);
            Console.Out.Flush();
        }
        protected override void Dispose(bool disposing) {
            if(disposing) tip.Dispose();
            base.Dispose(disposing);
        }
    }
    [STAThread] static int Main(string[] args) {
        int parentId;
        if((args.Length != 1 && (args.Length != 2 || args[1] != "--diagnose")) || !Int32.TryParse(args[0], out parentId)) return 2;
        if(!SetProcessDpiAwarenessContext(new IntPtr(-4))) {
            Console.Error.WriteLine("Desktop trigger requires per-monitor DPI awareness");
            return 3;
        }
        if(args.Length == 2) {
            var host = DesktopHost();
            if(host == IntPtr.Zero) { Console.Error.WriteLine("Explorer desktop unavailable"); return 4; }
            foreach(var screen in Screen.AllScreens) {
                int scale = Scale(screen);
                using(var window = new Trigger(host, screen, scale)) {
                    NativeRect actual;
                    if(!window.Attached || !GetWindowRect(window.Handle, out actual) ||
                        actual.Left != window.TargetBounds.Left || actual.Top != window.TargetBounds.Top ||
                        actual.Right - actual.Left != window.TargetBounds.Width || actual.Bottom - actual.Top != window.TargetBounds.Height) {
                        Console.Error.WriteLine("Desktop trigger geometry or parent validation failed"); return 5;
                    }
                    Console.WriteLine("display " + screen.DeviceName + " scale " + scale + " bounds " + window.TargetBounds + " explorer-child true topmost false");
                }
            }
            return 0;
        }
        var input = new Thread(() => {
            string line;
            while((line = Console.ReadLine()) != null) enabled = line == "enabled";
            inputEnded = true;
        });
        input.IsBackground = true; input.Start();
        Application.EnableVisualStyles();
        var context = new ApplicationContext();
        var windows = new System.Collections.Generic.List<Trigger>();
        IntPtr desktop = IntPtr.Zero;
        string previous = null;
        var timer = new System.Windows.Forms.Timer(); timer.Interval = 800;
        timer.Tick += (sender, e) => {
            try { using(var process = Process.GetProcessById(parentId)) if(inputEnded || process.HasExited) { context.ExitThread(); return; } }
            catch(ArgumentException) { context.ExitThread(); return; }
            try {
                var next = DesktopHost();
                var screens = Screen.AllScreens;
                var signature = String.Join(";", Array.ConvertAll(screens, screen => screen.DeviceName + ":" + screen.Bounds + ":" + screen.WorkingArea + ":" + Scale(screen)));
                if(next != desktop || previous != signature || !IsWindow(desktop) || windows.Exists(window => !window.Attached)) {
                    foreach(var window in windows) window.Dispose(); windows.Clear();
                    desktop = next; previous = signature;
                    if(desktop != IntPtr.Zero) foreach(var screen in screens) windows.Add(new Trigger(desktop, screen, Scale(screen)));
                }
                foreach(var window in windows) {
                    if(enabled && window.Attached) {
                        if(!window.Visible) window.Show();
                        if(!window.Attached) window.Hide();
                    }
                    else window.Hide();
                }
            } catch(Exception error) {
                foreach(var window in windows) window.Dispose(); windows.Clear();
                Console.Error.WriteLine("Desktop trigger disabled: " + error.Message);
                context.ExitThread();
            }
        };
        timer.Start();
        Console.WriteLine("ready"); Console.Out.Flush();
        Application.Run(context);
        timer.Dispose(); foreach(var window in windows) window.Dispose();
        return 0;
    }
}
