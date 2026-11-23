$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if (!$IsWindows) { throw 'A native Windows runner is required' }
$revision = $env:VERIFY65567_REVISION
if ($revision -notin @('baseline', 'candidate')) { throw 'Unknown revision' }
$repository = (Resolve-Path '.').Path
$product = (Resolve-Path 'packages/core').Path
$test = Join-Path $product 'test'
$bun = (Get-Command bun -CommandType Application | Select-Object -First 1).Source
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$checkout = git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Could not identify checkout' }
$driver = git rev-parse HEAD:packages/core/src/environment/local.ts
if ($LASTEXITCODE -ne 0) { throw 'Could not identify the local driver' }
Write-Host "revision=$revision checkout=$checkout driver=$driver"
if (($revision -eq 'baseline') -ne ($driver -eq '623ff00faf60bd7af966bb9a7f9c78f76a386b91')) {
  throw "Expected an unchanged driver in the baseline and a modified driver in the candidate"
}

$token = [guid]::NewGuid().ToString()
$scope = Join-Path $env:RUNNER_TEMP "verify65567-$token"
$backing = [IO.Directory]::CreateDirectory((Join-Path $scope 'backing')).FullName
[IO.File]::WriteAllText((Join-Path $backing '.verify65567'), $token)
$used = [IO.Directory]::GetLogicalDrives()
$drive = $null
foreach ($n in (90..82)) {
  $candidate = ([char]$n).ToString() + ':'
  if ($used -notcontains ($candidate + '\')) { $drive = $candidate; break }
}
if (!$drive) { throw 'No free drive letter in R–Z' }
& subst.exe $drive $backing
if ($LASTEXITCODE -ne 0) { throw "subst failed for $drive" }
try {
  $env:VERIFY65567_ROOT = $drive + '\'
  $env:VERIFY65567_MARKER = $token
  foreach ($key in @('HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR',
                     'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME')) {
    $leaf = switch ($key) {
      'USERPROFILE' { 'HOME' }
      'TEMP' { 'TMP' }
      'TMPDIR' { 'TMP' }
      default { $key }
    }
    $isolated = [IO.Directory]::CreateDirectory((Join-Path $scope $leaf)).FullName
    [Environment]::SetEnvironmentVariable($key, $isolated, 'Process')
  }
  $env:GIT_CONFIG_GLOBAL = 'NUL'
  $env:GIT_CONFIG_NOSYSTEM = '1'
  $env:OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = 'true'
  $fixture = [IO.File]::ReadAllText((Join-Path $test 'tool-edit.test.ts'))
  $cases = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'bun-case.inc'))
  [IO.File]::WriteAllText((Join-Path $test 'verify65567.test.ts'), $fixture + "`n" + $cases)
  Copy-Item (Join-Path $PSScriptRoot 'drive.mjs') (Join-Path $test 'verify65567-drive.mjs')
  Copy-Item (Join-Path $PSScriptRoot 'node-case.ts') (Join-Path $test 'verify65567-node.ts')
  Set-Location $product
  & $bun --version
  & $node --version
  & $bun test --timeout 60000 --test-name-pattern 'verify-65567 native edit' ./test/verify65567.test.ts
  $bunStatus = $LASTEXITCODE
  & $bun build ./test/verify65567-node.ts --target=node --packages=external --outfile=./test/verify65567-node.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Could not build the Node driver probe' }
  & $node ./test/verify65567-node.mjs
  $nodeStatus = $LASTEXITCODE
  if ($bunStatus -ne 0 -or $nodeStatus -ne 0) { throw "Bun exit=$bunStatus, Node exit=$nodeStatus" }
} finally {
  Set-Location $repository
  & subst.exe $drive /d
  if ($LASTEXITCODE -ne 0) { throw "Could not unmount $drive" }
}
