output "cluster_id" {
  description = "Non-secret DOKS identifier used for constrained deployment setup."
  value       = digitalocean_kubernetes_cluster.staging.id
}

output "database_host" {
  description = "Private database hostname; credentials are intentionally excluded."
  value       = digitalocean_database_cluster.postgres.private_host
}

output "database_name" {
  description = "Application database name."
  value       = digitalocean_database_db.portal.name
}

output "private_bucket" {
  description = "Private staging object bucket."
  value       = digitalocean_spaces_bucket.private.name
}

output "public_derivative_bucket" {
  description = "Bucket whose individual promoted objects may receive public-read ACLs."
  value       = digitalocean_spaces_bucket.public_derivatives.name
}

output "registry_endpoint" {
  description = "Private registry endpoint."
  value       = digitalocean_container_registry.portal.endpoint
}
