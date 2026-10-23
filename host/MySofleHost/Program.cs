using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Net;
using System.Net.Sockets;
using Microsoft.Win32;

namespace MySofleHost;

static class Program
{
    public const string HostExe = "zmk-hid-host.exe";
    public const string ConfigFile = "qmk-hid-host.json";
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string RunName = "MySofleHost";

    [STAThread]
    static void Main()
    {
        using var mutex = new Mutex(true, @"Local\MySofleHost.SingleInstance", out bool created);
        if (!created) return;
        ApplicationConfiguration.Initialize();
        using var ctx = new TrayContext();
        Application.Run(ctx);
    }

    sealed class TrayContext : ApplicationContext
    {
        readonly NotifyIcon tray;
        readonly ToolStripMenuItem statusItem, autostartItem;
        readonly System.Windows.Forms.Timer timer = new() { Interval = 1000 };
        readonly string dir = AppContext.BaseDirectory;
        readonly StaticServer server;
        Process? hostProc;
        DateTime? restartAt;
        bool quitting;

        public TrayContext()
        {
            CleanupOrphans();

            var webDir = FindWebDirectory(dir);
            server = new StaticServer(webDir, 8765);
            server.Start();

            statusItem = new ToolStripMenuItem("Layout monitor: Starting") { Enabled = false };
            autostartItem = new ToolStripMenuItem("Start with Windows") { CheckOnClick = true, Checked = IsAutostart() };
            autostartItem.CheckedChanged += (_, _) => SetAutostart(autostartItem.Checked);

            var openItem = new ToolStripMenuItem("Open Configurator", null, (_, _) => OpenConfigurator())
            {
                Font = new Font(SystemFonts.MenuFont ?? Control.DefaultFont, FontStyle.Bold)
            };

            var menu = new ContextMenuStrip();
            menu.Items.Add(new ToolStripMenuItem("Sofle Keyboard") { Enabled = false });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(openItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(statusItem);
            menu.Items.Add("Restart monitor", null, (_, _) => RestartHost());
            menu.Items.Add(autostartItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit", null, (_, _) => Quit());

            tray = new NotifyIcon
            {
                Icon = MakeIcon(),
                Text = "Sofle (HE/EN Monitor active)",
                ContextMenuStrip = menu,
                Visible = true
            };

            tray.DoubleClick += (_, _) => OpenConfigurator();
            tray.MouseClick += (_, e) =>
            {
                if (e.Button == MouseButtons.Left) OpenConfigurator();
            };

            timer.Tick += (_, _) => Tick();
            timer.Start();

            StartHost();
        }

        void OpenConfigurator()
        {
            var url = server.Url;
            string[] candidates = {
                @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Edge SxS\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe"),
            };

            foreach (var exe in candidates)
            {
                if (File.Exists(exe))
                {
                    try
                    {
                        var psi = new ProcessStartInfo(exe, $"--app=\"{url}\"")
                        {
                            UseShellExecute = false
                        };
                        Process.Start(psi);
                        return;
                    }
                    catch { }
                }
            }

            // Fallback: system default browser
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch { }
        }

        static string FindWebDirectory(string baseDir)
        {
            string[] attempts = {
                Path.Combine(baseDir, "web"),
                Path.Combine(baseDir, "..", "web"),
                Path.Combine(baseDir, "..", "..", "zmk-config-sofle", "web"),
                Path.Combine(baseDir, "..", "..", "..", "zmk-config-sofle", "web"),
                Path.Combine(baseDir, "..", "..", "..", "..", "zmk-config-sofle", "web"),
            };

            foreach (var a in attempts)
            {
                var full = Path.GetFullPath(a);
                if (Directory.Exists(full) && File.Exists(Path.Combine(full, "index.html")))
                    return full;
            }

            return baseDir;
        }

        static (string exePath, string configPath) FindHostFiles(string baseDir)
        {
            string[] attempts = {
                baseDir,
                Path.Combine(baseDir, "..", "..", "zmk-hid-host"),
                Path.Combine(baseDir, "..", "..", "..", "zmk-hid-host"),
                Path.Combine(baseDir, "..", "zmk-hid-host")
            };

            foreach (var a in attempts)
            {
                var full = Path.GetFullPath(a);
                var exe = Path.Combine(full, HostExe);
                var cfg = Path.Combine(full, ConfigFile);
                if (File.Exists(exe) && File.Exists(cfg))
                    return (exe, cfg);
            }

            return (Path.Combine(baseDir, HostExe), Path.Combine(baseDir, ConfigFile));
        }

        static void CleanupOrphans()
        {
            try
            {
                foreach (var name in new[] { "zmk-hid-host", "zmk-hid-host.silent" })
                {
                    foreach (var p in Process.GetProcessesByName(name))
                    {
                        try { p.Kill(true); p.WaitForExit(1000); } catch { }
                    }
                }
            }
            catch { }
        }

        void StartHost()
        {
            try
            {
                var (exe, cfg) = FindHostFiles(dir);
                if (!File.Exists(exe))
                {
                    hostProc = null;
                    SetStatus("Host binary missing");
                    return;
                }

                var psi = new ProcessStartInfo(exe)
                {
                    WorkingDirectory = Path.GetDirectoryName(exe) ?? dir,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden,
                };
                psi.ArgumentList.Add("-c");
                psi.ArgumentList.Add(cfg);

                hostProc = Process.Start(psi);
                restartAt = null;
                SetStatus(hostProc != null ? "Active" : "Restarting");
                if (hostProc == null) restartAt = DateTime.UtcNow.AddSeconds(2);
            }
            catch
            {
                hostProc = null;
                restartAt = DateTime.UtcNow.AddSeconds(2);
                SetStatus("Restarting");
            }
        }

        void Tick()
        {
            if (quitting) return;
            if (hostProc != null && hostProc.HasExited)
            {
                hostProc.Dispose();
                hostProc = null;
                restartAt = DateTime.UtcNow.AddSeconds(2);
                SetStatus("Restarting");
            }
            if (hostProc == null && restartAt is { } t && DateTime.UtcNow >= t) StartHost();
        }

        void RestartHost()
        {
            KillHost();
            StartHost();
        }

        void KillHost()
        {
            try { if (hostProc is { HasExited: false }) { hostProc.Kill(true); hostProc.WaitForExit(2000); } } catch { }
            hostProc?.Dispose();
            hostProc = null;
        }

        void SetStatus(string s)
        {
            statusItem.Text = "Layout monitor: " + s;
            tray.Text = "Sofle (HE/EN Monitor: " + s + ")";
        }

        void Quit()
        {
            quitting = true;
            timer.Stop();
            KillHost();
            server.Dispose();
            tray.Visible = false;
            tray.Dispose();
            Application.Exit();
        }

        static bool IsAutostart()
        {
            using var k = Registry.CurrentUser.OpenSubKey(RunKey);
            return k?.GetValue(RunName) != null;
        }

        static void SetAutostart(bool on)
        {
            using var k = Registry.CurrentUser.CreateSubKey(RunKey);
            if (on) k.SetValue(RunName, $"\"{Environment.ProcessPath}\"");
            else k.DeleteValue(RunName, false);
        }

        static Icon MakeIcon()
        {
            try
            {
                var icoPath = Path.Combine(AppContext.BaseDirectory, "app.ico");
                if (File.Exists(icoPath))
                {
                    return new Icon(icoPath, 32, 32);
                }

                if (Environment.ProcessPath != null)
                {
                    var extracted = Icon.ExtractAssociatedIcon(Environment.ProcessPath);
                    if (extracted != null) return extracted;
                }
            }
            catch { }

            // High-DPI fallback icon drawing
            using var bmp = new Bitmap(32, 32);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using var body = new SolidBrush(Color.FromArgb(20, 24, 32));
                using var border = new Pen(Color.FromArgb(56, 189, 248), 1.5f);
                using var key = new SolidBrush(Color.FromArgb(71, 85, 105));
                using var cyan = new SolidBrush(Color.FromArgb(56, 189, 248));
                using var rose = new SolidBrush(Color.FromArgb(244, 63, 94));
                using var knob = new SolidBrush(Color.FromArgb(168, 85, 247));
                using var path = new GraphicsPath();
                path.AddArc(2, 2, 8, 8, 180, 90);
                path.AddArc(22, 2, 8, 8, 270, 90);
                path.AddArc(22, 22, 8, 8, 0, 90);
                path.AddArc(2, 22, 8, 8, 90, 90);
                path.CloseFigure();
                g.FillPath(body, path);
                g.DrawPath(border, path);

                // Left staggered keys
                g.FillRectangle(key, 5, 8, 3, 3);
                g.FillRectangle(cyan, 9, 6, 3, 3);
                g.FillRectangle(key, 9, 10, 3, 3);
                g.FillRectangle(cyan, 8, 19, 4, 3);

                // Right staggered keys
                g.FillRectangle(rose, 20, 6, 3, 3);
                g.FillRectangle(key, 20, 10, 3, 3);
                g.FillRectangle(key, 24, 8, 3, 3);
                g.FillRectangle(rose, 20, 19, 4, 3);

                // Center knob
                g.FillEllipse(knob, 14, 13, 5, 5);
            }
            var h = bmp.GetHicon();
            try { return (Icon)Icon.FromHandle(h).Clone(); }
            finally { DestroyIcon(h); }
        }

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        static extern bool DestroyIcon(IntPtr h);
    }

    sealed class StaticServer : IDisposable
    {
        readonly HttpListener listener = new();
        readonly string rootDir;
        readonly int port;
        CancellationTokenSource? cts;

        public int Port => port;
        public string Url => $"http://127.0.0.1:{port}/";

        public StaticServer(string rootDir, int preferredPort = 8765)
        {
            this.rootDir = Path.GetFullPath(rootDir);

            int p = preferredPort;
            while (p < preferredPort + 50)
            {
                try
                {
                    listener.Prefixes.Clear();
                    listener.Prefixes.Add($"http://127.0.0.1:{p}/");
                    listener.Start();
                    port = p;
                    return;
                }
                catch
                {
                    p++;
                }
            }

            // Fallback: pick random available port
            port = GetFreePort();
            listener.Prefixes.Clear();
            listener.Prefixes.Add($"http://127.0.0.1:{port}/");
            listener.Start();
        }

        static int GetFreePort()
        {
            using var s = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            s.Bind(new IPEndPoint(IPAddress.Loopback, 0));
            return ((IPEndPoint)s.LocalEndPoint!).Port;
        }

        public void Start()
        {
            cts = new CancellationTokenSource();
            _ = Task.Run(() => Loop(cts.Token));
        }

        async Task Loop(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested && listener.IsListening)
            {
                try
                {
                    var ctx = await listener.GetContextAsync();
                    _ = Task.Run(() => Handle(ctx));
                }
                catch when (ct.IsCancellationRequested) { break; }
                catch { }
            }
        }

        void Handle(HttpListenerContext ctx)
        {
            try
            {
                var req = ctx.Request;
                var res = ctx.Response;
                var rawPath = req.Url?.AbsolutePath.TrimStart('/') ?? "";
                if (string.IsNullOrEmpty(rawPath)) rawPath = "index.html";

                var filePath = Path.GetFullPath(Path.Combine(rootDir, rawPath));

                // Path traversal guard
                if (!filePath.StartsWith(rootDir, StringComparison.OrdinalIgnoreCase) || !File.Exists(filePath))
                {
                    res.StatusCode = 404;
                    res.Close();
                    return;
                }

                var ext = Path.GetExtension(filePath).ToLowerInvariant();
                var contentType = ext switch
                {
                    ".html" => "text/html; charset=utf-8",
                    ".js" or ".mjs" => "application/javascript; charset=utf-8",
                    ".css" => "text/css; charset=utf-8",
                    ".json" => "application/json; charset=utf-8",
                    ".svg" => "image/svg+xml",
                    ".png" => "image/png",
                    ".jpg" or ".jpeg" => "image/jpeg",
                    ".ico" => "image/x-icon",
                    _ => "application/octet-stream"
                };

                res.ContentType = contentType;
                res.Headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
                res.Headers["Access-Control-Allow-Origin"] = "*";
                var bytes = File.ReadAllBytes(filePath);
                res.ContentLength64 = bytes.Length;
                res.OutputStream.Write(bytes, 0, bytes.Length);
                res.Close();
            }
            catch { }
        }

        public void Dispose()
        {
            cts?.Cancel();
            try { listener.Stop(); } catch { }
            try { listener.Close(); } catch { }
        }
    }
}
