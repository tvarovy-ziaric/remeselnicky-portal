locals {
  prefix = "portal-staging-${var.name_suffix}"
  tags   = ["portal", "staging", "synthetic-data-only"]
}

resource "digitalocean_vpc" "staging" {
  name        = "${local.prefix}-vpc"
  description = "Isolated Remeselnicky portal staging network"
  region      = var.region
  ip_range    = var.vpc_ip_range
}

resource "digitalocean_kubernetes_cluster" "staging" {
  name          = "${local.prefix}-doks"
  region        = var.region
  version       = var.kubernetes_version
  vpc_uuid      = digitalocean_vpc.staging.id
  auto_upgrade  = true
  surge_upgrade = true
  tags          = local.tags

  maintenance_policy {
    day        = "sunday"
    start_time = "03:00"
  }

  node_pool {
    name       = "staging-default"
    size       = "s-2vcpu-8gb"
    node_count = 1
    auto_scale = false
    tags       = local.tags
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "digitalocean_database_cluster" "postgres" {
  name                 = "${local.prefix}-postgres"
  engine               = "pg"
  version              = "17"
  size                 = "db-s-1vcpu-1gb"
  region               = var.region
  node_count           = 1
  private_network_uuid = digitalocean_vpc.staging.id
  tags                  = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "digitalocean_database_db" "portal" {
  cluster_id = digitalocean_database_cluster.postgres.id
  name       = "portal_staging"
}

resource "digitalocean_database_firewall" "postgres" {
  cluster_id = digitalocean_database_cluster.postgres.id

  rule {
    type  = "k8s"
    value = digitalocean_kubernetes_cluster.staging.id
  }
}

resource "digitalocean_container_registry" "portal" {
  name                   = replace("${local.prefix}-registry", "-", "")
  subscription_tier_slug = "basic"
  region                 = var.region
}

resource "digitalocean_spaces_bucket" "private" {
  name   = "${local.prefix}-private"
  region = var.region
  acl    = "private"

  versioning {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "digitalocean_spaces_bucket" "public_derivatives" {
  name   = "${local.prefix}-public"
  region = var.region
  acl    = "private"

  versioning {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "digitalocean_project" "staging" {
  name        = "Remeselnicky portal staging"
  description = "Synthetic-data-only isolated staging environment"
  purpose     = "Web Application"
  environment = "Staging"
  resources = [
    digitalocean_kubernetes_cluster.staging.urn,
    digitalocean_database_cluster.postgres.urn,
    digitalocean_spaces_bucket.private.urn,
    digitalocean_spaces_bucket.public_derivatives.urn,
  ]
}
