$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$certDir = Join-Path $projectRoot 'certs'
$privateCertDir = Join-Path $env:LOCALAPPDATA 'ScalePad'
$certPath = Join-Path $certDir 'scalepad.crt'
$keyPath = Join-Path $privateCertDir 'scalepad.key'
$configPath = Join-Path $certDir 'openssl-scalepad.cnf'

New-Item -ItemType Directory -Force -Path $certDir | Out-Null
New-Item -ItemType Directory -Force -Path $privateCertDir | Out-Null
$ipCandidates = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object {
    $_.IPAddress -notlike '127.*' -and
    $_.IPAddress -notlike '169.254.*' -and
    $_.PrefixOrigin -ne 'WellKnown' -and
    $_.InterfaceAlias -notmatch 'Tailscale|VPN|Virtual|Loopback'
  }
$localIp = $ipCandidates |
  Where-Object { $_.InterfaceAlias -match 'Wi-?Fi|WLAN|Ethernet' } |
  Select-Object -First 1 -ExpandProperty IPAddress
if (-not $localIp) {
  $localIp = $ipCandidates | Select-Object -First 1 -ExpandProperty IPAddress
}
if (-not $localIp) { throw 'No LAN IPv4 address found. Connect this PC to Wi-Fi or Ethernet.' }

$openssl = Get-Command openssl -ErrorAction SilentlyContinue
if (-not $openssl) { throw 'OpenSSL was not found. Install OpenSSL or use the HTTP-only option.' }

if (-not (Test-Path $certPath) -or -not (Test-Path $keyPath)) {
  @"
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = ScalePad local installation

[v3_req]
subjectAltName = IP:$localIp, DNS:localhost
basicConstraints = critical, CA:true
keyUsage = critical, digitalSignature, keyEncipherment, keyCertSign
extendedKeyUsage = serverAuth
"@ | Set-Content -Path $configPath -Encoding ascii

  & $openssl.Source req -x509 -nodes -newkey rsa:2048 `
    -keyout $keyPath -out $certPath -days 825 -config $configPath
  Remove-Item -Force $configPath
  Write-Host "Generated local certificate: $certPath"
} else {
  Write-Host "Reusing local certificate: $certPath"
}

Write-Host "Open this URL in iPad Safari: https://$localIp`:8443/"
Write-Host "Download the certificate first from:"
Write-Host "http://$localIp`:8000/certs/scalepad.crt"
python (Join-Path $projectRoot 'serve_https.py') --bind 0.0.0.0 --port 8443 --cert $certPath --key $keyPath
