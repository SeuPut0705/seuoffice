// Windows Explorer & Desktop Spacebar Quick Look helper.
// Runs as a child process of IeumOffice when the user enables Windows Explorer
// Spacebar preview. Watches stdin and exits immediately when the parent closes
// the pipe so the helper can never outlive the app.

using System;
using System.Collections.Concurrent;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace IeumOffice.QuickLook
{
    internal static class Program
    {
        private const int WH_KEYBOARD_LL = 13;
        private const int WM_KEYDOWN = 0x0100;

        private const int VK_SPACE = 0x20;
        private const int VK_ESCAPE = 0x1B;
        private const int VK_LEFT = 0x25;
        private const int VK_UP = 0x26;
        private const int VK_RIGHT = 0x27;
        private const int VK_DOWN = 0x28;

        private const int VK_SHIFT = 0x10;
        private const int VK_CONTROL = 0x11;
        private const int VK_MENU = 0x12;
        private const int VK_LWIN = 0x5B;
        private const int VK_RWIN = 0x5C;

        private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int left;
            public int top;
            public int right;
            public int bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct GUITHREADINFO
        {
            public int cbSize;
            public int flags;
            public IntPtr hwndActive;
            public IntPtr hwndFocus;
            public IntPtr hwndCapture;
            public IntPtr hwndMenuOwner;
            public IntPtr hwndMoveSize;
            public IntPtr hwndCaret;
            public RECT rcCaret;
        }

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll")]
        private static extern IntPtr GetParent(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int vKey);

        [ComImport]
        [Guid("6D5140C1-7436-11CE-8034-00AA006009FA")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IServiceProvider
        {
            [PreserveSig]
            int QueryService(ref Guid guidService, ref Guid riid, out IntPtr ppvObject);
        }

        [ComImport]
        [Guid("00000114-0000-0000-C000-000000000046")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IOleWindow
        {
            [PreserveSig]
            int GetWindow(out IntPtr phwnd);

            [PreserveSig]
            int ContextSensitiveHelp([MarshalAs(UnmanagedType.Bool)] bool fEnterMode);
        }

        private static Guid SID_STopLevelBrowser = new Guid("4C96BE40-915C-11CF-99D3-00AA004AE837");
        private static Guid IID_IOleWindow = new Guid("00000114-0000-0000-C000-000000000046");

        private struct KeyEventItem
        {
            public IntPtr ForegroundHwnd;
            public bool IsDesktop;
            public uint VkCode;
        }

        private static readonly BlockingCollection<KeyEventItem> Queue = new BlockingCollection<KeyEventItem>(64);
        private static LowLevelKeyboardProc _proc;
        private static IntPtr _hookId = IntPtr.Zero;

        [STAThread]
        private static void Main()
        {
            Console.OutputEncoding = new UTF8Encoding(false);

            // Watch stdin so closing the parent process terminates this helper immediately.
            Thread parentWatcher = new Thread(() =>
            {
                try
                {
                    while (Console.In.ReadLine() != null)
                    {
                        // Keep reading until EOF.
                    }
                }
                catch
                {
                    // Ignore pipe errors.
                }
                Environment.Exit(0);
            });
            parentWatcher.IsBackground = true;
            parentWatcher.Start();

            // Dedicated STA thread for Shell COM queries so the keyboard hook never blocks.
            Thread staWorker = new Thread(RunStaWorker);
            staWorker.SetApartmentState(ApartmentState.STA);
            staWorker.IsBackground = true;
            staWorker.Start();

            _proc = HookCallback;
            using (var curProcess = System.Diagnostics.Process.GetCurrentProcess())
            using (var curModule = curProcess.MainModule)
            {
                _hookId = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(curModule.ModuleName), 0);
            }

            if (_hookId == IntPtr.Zero)
            {
                WriteJson("{\"type\":\"error\",\"message\":\"SetWindowsHookEx failed\"}");
                return;
            }

            WriteJson("{\"type\":\"ready\"}");
            Application.Run();
            UnhookWindowsHookEx(_hookId);
        }

        private static bool IsModifierDown()
        {
            return (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0 ||
                   (GetAsyncKeyState(VK_MENU) & 0x8000) != 0 ||
                   (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0 ||
                   (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;
        }

        private static string GetWindowClass(IntPtr hWnd)
        {
            if (hWnd == IntPtr.Zero) return string.Empty;
            var sb = new StringBuilder(128);
            int len = GetClassName(hWnd, sb, sb.Capacity);
            return len > 0 ? sb.ToString() : string.Empty;
        }

        private static bool IsFileListFocused(IntPtr fg)
        {
            uint pid;
            uint tid = GetWindowThreadProcessId(fg, out pid);
            if (tid == 0) return false;

            var gui = new GUITHREADINFO();
            gui.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
            if (!GetGUIThreadInfo(tid, ref gui)) return false;

            // Reject if a text caret is active or focus is inside an Edit/text control.
            IntPtr focus = gui.hwndFocus;
            if (focus == IntPtr.Zero) return false;

            string focusClass = GetWindowClass(focus);
            if (focusClass != "DirectUIHWND" && focusClass != "SysListView32")
            {
                return false;
            }

            // Ensure the list view belongs to SHELLDLL_DefView (file view, not another pane).
            IntPtr cur = focus;
            for (int depth = 0; depth < 4 && cur != IntPtr.Zero; depth++)
            {
                string cls = GetWindowClass(cur);
                if (cls == "SHELLDLL_DefView") return true;
                cur = GetParent(cur);
            }
            return false;
        }

        private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0 && wParam == (IntPtr)WM_KEYDOWN)
            {
                var kb = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                uint vk = kb.vkCode;
                if (vk == VK_SPACE || vk == VK_ESCAPE || vk == VK_UP || vk == VK_DOWN || vk == VK_LEFT || vk == VK_RIGHT)
                {
                    if (!IsModifierDown() && (vk != VK_SPACE || (GetAsyncKeyState(VK_SHIFT) & 0x8000) == 0))
                    {
                        IntPtr fg = GetForegroundWindow();
                        string fgClass = GetWindowClass(fg);
                        bool isExplorer = fgClass == "CabinetWClass" || fgClass == "ExploreWClass";
                        bool isDesktop = fgClass == "Progman" || fgClass == "WorkerW";
                        if ((isExplorer || isDesktop) && IsFileListFocused(fg))
                        {
                            Queue.TryAdd(new KeyEventItem
                            {
                                ForegroundHwnd = fg,
                                IsDesktop = isDesktop,
                                VkCode = vk,
                            });
                        }
                    }
                }
            }
            return CallNextHookEx(_hookId, nCode, wParam, lParam);
        }

        private static void RunStaWorker()
        {
            Type shellType = Type.GetTypeFromProgID("Shell.Application");
            if (shellType == null) return;
            dynamic shell = Activator.CreateInstance(shellType);

            foreach (KeyEventItem item in Queue.GetConsumingEnumerable())
            {
                try
                {
                    if (item.VkCode == VK_ESCAPE)
                    {
                        WriteJson("{\"type\":\"escape\"}");
                        continue;
                    }

                    if (item.VkCode != VK_SPACE)
                    {
                        // Give Explorer a brief moment to update the selected item after an arrow key.
                        Thread.Sleep(35);
                    }

                    string path = GetSelectedFilePath(shell, item.ForegroundHwnd, item.IsDesktop);
                    if (!string.IsNullOrEmpty(path))
                    {
                        string kind = item.VkCode == VK_SPACE ? "space" : "nav";
                        WriteJson("{\"type\":\"" + kind + "\",\"path\":\"" + EscapeJson(path) + "\"}");
                    }
                }
                catch
                {
                    // Ignore transient COM errors while Explorer tabs are opening/closing.
                }
            }
        }

        private static IntPtr GetActiveShellTabHwnd(IntPtr explorerHwnd)
        {
            IntPtr child = IntPtr.Zero;
            while (true)
            {
                child = FindWindowEx(explorerHwnd, child, "ShellTabWindowClass", null);
                if (child == IntPtr.Zero) break;
                if (IsWindowVisible(child)) return child;
            }
            return FindWindowEx(explorerHwnd, IntPtr.Zero, "ShellTabWindowClass", null);
        }

        private static IntPtr GetBrowserTabHwnd(object webBrowserApp)
        {
            var sp = webBrowserApp as IServiceProvider;
            if (sp == null) return IntPtr.Zero;
            IntPtr unk;
            int hr = sp.QueryService(ref SID_STopLevelBrowser, ref IID_IOleWindow, out unk);
            if (hr != 0 || unk == IntPtr.Zero) return IntPtr.Zero;
            try
            {
                var oleWin = Marshal.GetObjectForIUnknown(unk) as IOleWindow;
                if (oleWin == null) return IntPtr.Zero;
                IntPtr hwnd;
                if (oleWin.GetWindow(out hwnd) == 0) return hwnd;
            }
            finally
            {
                Marshal.Release(unk);
            }
            return IntPtr.Zero;
        }

        private static string ExtractSelectionFromWindow(dynamic win)
        {
            if (win == null) return null;
            dynamic doc = win.Document;
            if (doc == null) return null;
            dynamic items = doc.SelectedItems();
            if (items != null && items.Count > 0)
            {
                dynamic first = items.Item(0);
                if (first != null) return first.Path as string;
            }
            dynamic focused = doc.FocusedItem;
            if (focused != null) return focused.Path as string;
            return null;
        }

        private static string GetSelectedFilePath(dynamic shell, IntPtr fgHwnd, bool isDesktop)
        {
            dynamic windows = shell.Windows();
            if (windows == null) return null;

            if (isDesktop)
            {
                // SWC_DESKTOP = 8, SWFO_NEEDDISPATCH = 1
                object loc = Type.Missing;
                object opts = Type.Missing;
                int hwndOut = 0;
                dynamic desktopWin = windows.FindWindowSW(ref loc, ref opts, 8, out hwndOut, 1);
                return ExtractSelectionFromWindow(desktopWin);
            }

            long targetHwnd = fgHwnd.ToInt64();
            IntPtr activeTabHwnd = GetActiveShellTabHwnd(fgHwnd);
            dynamic fallbackWin = null;

            int count = windows.Count;
            for (int i = 0; i < count; i++)
            {
                dynamic win = null;
                try
                {
                    win = windows.Item(i);
                    if (win == null) continue;
                    long hwnd = (long)win.HWND;
                    if (hwnd != targetHwnd) continue;

                    if (activeTabHwnd != IntPtr.Zero)
                    {
                        IntPtr tabHwnd = GetBrowserTabHwnd(win);
                        if (tabHwnd == activeTabHwnd)
                        {
                            return ExtractSelectionFromWindow(win);
                        }
                    }

                    if (fallbackWin == null) fallbackWin = win;
                }
                catch
                {
                    // Ignore inaccessible browser entries.
                }
            }

            return ExtractSelectionFromWindow(fallbackWin);
        }

        private static string EscapeJson(string s)
        {
            var sb = new StringBuilder(s.Length + 8);
            foreach (char c in s)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20)
                        {
                            sb.AppendFormat("\\u{0:x4}", (int)c);
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            return sb.ToString();
        }

        private static void WriteJson(string line)
        {
            try
            {
                Console.Out.WriteLine(line);
                Console.Out.Flush();
            }
            catch
            {
                Environment.Exit(0);
            }
        }
    }
}
