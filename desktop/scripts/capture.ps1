# Saves a picture of a window as PNG, even when other windows cover it: PrintWindow with PW_RENDERFULLCONTENT reads
# what DWM composed, GPU content (WebView2, mpv) included. For tests that run while you use the computer.
# -Client keeps only the window's inside, without the title bar and borders.
# Usage: powershell -File capture.ps1 -ProcessId <pid> -Out shot.png [-Client]
param([Parameter(Mandatory)] [int] $ProcessId, [Parameter(Mandatory)] [string] $Out, [switch] $Client)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Capture {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

[void][Capture]::SetProcessDPIAware()
$hwnd = [Capture]::Find([uint32]$ProcessId)
if ($hwnd -eq [IntPtr]::Zero) { throw "No visible window for process $ProcessId" }
$rect = New-Object Capture+RECT
[void][Capture]::GetWindowRect($hwnd, [ref]$rect)
$bitmap = New-Object System.Drawing.Bitmap ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
[void][Capture]::PrintWindow($hwnd, $hdc, 2)
$graphics.ReleaseHdc($hdc)
$graphics.Dispose()
if ($Client) {
  $inside = New-Object Capture+RECT
  [void][Capture]::GetClientRect($hwnd, [ref]$inside)
  $origin = New-Object Capture+POINT
  [void][Capture]::ClientToScreen($hwnd, [ref]$origin)
  $area = New-Object System.Drawing.Rectangle ($origin.X - $rect.Left), ($origin.Y - $rect.Top), $inside.Right, $inside.Bottom
  $cropped = $bitmap.Clone($area, $bitmap.PixelFormat)
  $bitmap.Dispose()
  $bitmap = $cropped
}
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
Write-Output $Out
