$token = $env:SUPABASE_ACCESS_TOKEN
if (-not $token) {
    Write-Host "Astuce : Vous pouvez définir la variable d'environnement SUPABASE_ACCESS_TOKEN pour éviter cette invite (utilisez votre SERVICE_SUPABASESERVICE_KEY)."
    $token = Read-Host -Prompt "Entrez votre jeton d'accès / clé service_role"
}
if (-not $token) {
    Write-Error "Erreur : Le jeton/clé est obligatoire."
    exit 1
}
$ref = "selfhosted"
$apiHost = "http://supabasekong-qwx5j3qfalx0jsygpvlj27x6.194.28.99.132.sslip.io"
$functionName = "server"

Write-Host "Deploying function '$functionName' to self-hosted project '$ref' via Supabase CLI..."

$env:SUPABASE_ACCESS_TOKEN = $token
try {
    supabase functions deploy $functionName --project-ref $ref --api-host $apiHost --no-verify-jwt
    Write-Host "SUCCESS!"
} catch {
    Write-Host "FAILED!"
    $_
}
