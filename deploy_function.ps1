$token = $env:SUPABASE_ACCESS_TOKEN
if (-not $token) {
    Write-Host "Astuce : Vous pouvez définir la variable d'environnement SUPABASE_ACCESS_TOKEN pour éviter cette invite."
    $token = Read-Host -Prompt "Entrez votre jeton d'accès Supabase (sbp_...)"
}
if (-not $token) {
    Write-Error "Erreur : Le jeton d'accès Supabase est obligatoire."
    exit 1
}
$ref = "fgdeeeaenffbekvgqiek"
$functionName = "make-server-752d1a39"

Write-Host "Deploying function '$functionName' to project '$ref' via Management API using curl.exe..."

$args = @(
  "--request", "POST",
  "--url", "https://api.supabase.com/v1/projects/$ref/functions/deploy?slug=$functionName",
  "--header", "Authorization: Bearer $token",
  "--form", 'metadata={\"entrypoint_path\": \"index.tsx\", \"name\": \"make-server-752d1a39\", \"verify_jwt\": false}',
  "--form", "file=@supabase/functions/server/index.tsx",
  "--fail"
)

try {
    & curl.exe @args
    Write-Host "SUCCESS!"
} catch {
    Write-Host "FAILED!"
    $_
}
