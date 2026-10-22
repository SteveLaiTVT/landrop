param(
    [string]$Source = "C:\Users\Administrator\WorkBuddy\FileTransfer\landrop\qa\screen.png",
    [string]$Target = "C:\Users\Administrator\WorkBuddy\FileTransfer\landrop\qa\desktop-app.png",
    [int]$X = 552,
    [int]$Y = 230,
    [int]$Width = 1456,
    [int]$Height = 939
)

Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($Source)
$crop = New-Object System.Drawing.Bitmap $Width, $Height
$gfx = [System.Drawing.Graphics]::FromImage($crop)
$destRect = New-Object System.Drawing.Rectangle 0, 0, $Width, $Height
$srcRect = New-Object System.Drawing.Rectangle $X, $Y, $Width, $Height
$gfx.DrawImage($src, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$crop.Save($Target, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose()
$crop.Dispose()
$src.Dispose()
Write-Output "cropped -> $Target"
