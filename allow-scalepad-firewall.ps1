# Run this script in an elevated PowerShell window after setting the WLAN profile to Private.
$ErrorActionPreference = 'Stop'

foreach ($port in 8000, 8443) {
  $name = "ScalePad local server $port"
  if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Private | Out-Null
  }
}

Write-Host 'ScalePad firewall rules for private network ports 8000 and 8443 are ready.'
