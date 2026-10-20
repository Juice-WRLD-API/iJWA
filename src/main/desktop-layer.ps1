# Puts a window into the desktop itself: above the Windows wallpaper, beneath the desktop icons and every window,
# untouched by Show Desktop (Win+D). Windows keeps the wallpaper and the icons in Progman, the desktop's window; asked
# (message 0x052C), it opens a WorkerW window for wallpapers to live in. On Windows 11 24H2 and later the WorkerW is a
# child of Progman, under the icons' view (SHELLDLL_DefView), and a window there must be layered to be drawn; before
# 24H2 the WorkerW is a window of its own just behind the one holding the icons.
#   desktop-layer.ps1 -Handle <window handle> -Left <px> -Top <px> -Width <px> -Height <px>   (the display, in pixels)
# Prints one JSON line: { ok, layout: "progman" | "workerw", error }.
param([long]$Handle, [int]$Left, [int]$Top, [int]$Width, [int]$Height)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IBailaDesk {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string name);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string name);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int index, int value);
  [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }

  const int GWL_STYLE = -16, GWL_EXSTYLE = -20;
  const int WS_CHILD = 0x40000000, WS_POPUP = unchecked((int)0x80000000), WS_VISIBLE = 0x10000000;
  const int WS_CLIPSIBLINGS = 0x04000000, WS_CLIPCHILDREN = 0x02000000, WS_EX_LAYERED = 0x80000;
  const uint SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40;

  public static string Place(IntPtr window, int left, int top, int width, int height) {
    SetProcessDpiAwarenessContext(new IntPtr(-4)); // pixels as they are
    IntPtr progman = FindWindow("Progman", null);
    if (progman == IntPtr.Zero) return "{\"ok\":false,\"error\":\"no desktop\"}";
    IntPtr ignored;
    SendMessageTimeout(progman, 0x052C, new IntPtr(0xD), new IntPtr(1), 0, 1000, out ignored);
    IntPtr icons = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
    IntPtr worker = FindWindowEx(progman, IntPtr.Zero, "WorkerW", null);
    string layout;
    IntPtr parent, after;
    if (icons != IntPtr.Zero && worker != IntPtr.Zero) {
      layout = "progman"; parent = progman; after = icons; // just beneath the icons
    } else {
      IntPtr found = IntPtr.Zero;
      EnumWindows((top_, l) => {
        if (FindWindowEx(top_, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) found = FindWindowEx(IntPtr.Zero, top_, "WorkerW", null);
        return true;
      }, IntPtr.Zero);
      if (found == IntPtr.Zero) return "{\"ok\":false,\"error\":\"no wallpaper window\"}";
      layout = "workerw"; parent = found; after = IntPtr.Zero;
    }
    int style = GetWindowLong(window, GWL_STYLE);
    SetWindowLong(window, GWL_STYLE, (style & ~WS_POPUP) | WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN);
    if (layout == "progman") {
      SetWindowLong(window, GWL_EXSTYLE, GetWindowLong(window, GWL_EXSTYLE) | WS_EX_LAYERED);
      SetLayeredWindowAttributes(window, 0, 255, 2);
    }
    SetParent(window, parent);
    RECT p;
    GetWindowRect(parent, out p);
    SetWindowPos(window, after, left - p.Left, top - p.Top, width, height, SWP_NOACTIVATE | (after == IntPtr.Zero ? 0x4u : 0u));
    return "{\"ok\":true,\"layout\":\"" + layout + "\"}";
  }
}
'@
try { [Console]::Out.WriteLine([IBailaDesk]::Place([IntPtr]$Handle, $Left, $Top, $Width, $Height)) }
catch { [Console]::Out.WriteLine((@{ ok = $false; error = "$_" } | ConvertTo-Json -Compress)) }
