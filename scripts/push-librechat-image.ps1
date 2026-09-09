# Build LibreChat from local source and push to Docker Hub.
# Prerequisites: docker login
# Usage:
#   .\scripts\push-librechat-image.ps1
#   .\scripts\push-librechat-image.ps1 -Tag 20260309

param(
  [string]$Image = "sultany/librechat",
  [string]$Tag = "latest"
)

$ErrorActionPreference = "Stop"
Set-Location (Resolve-Path (Join-Path $PSScriptRoot ".."))

$full = "${Image}:${Tag}"
Write-Host "==> Building $full (this can take a long time)..."
docker compose build api
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# override sets image: sultany/librechat:latest — retag if user passed another tag
if ($Tag -ne "latest") {
  docker tag "${Image}:latest" $full
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "==> Pushing $full ..."
docker push $full
if ($LASTEXITCODE -ne 0) {
  Write-Host "Push failed. Run: docker login"
  exit $LASTEXITCODE
}

if ($Tag -ne "latest") {
  Write-Host "==> Pushing ${Image}:latest ..."
  docker push "${Image}:latest"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "==> Done."
Write-Host "Online: copy deploy/docker-compose.override.online.example.yml to docker-compose.override.yml"
Write-Host "        then: docker compose pull api && docker compose up -d"
