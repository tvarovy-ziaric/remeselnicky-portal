terraform {
  required_version = "~> 1.11"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.100.0"
    }
  }

  # Initialize only after the separately approved state bucket exists:
  # tofu init -backend-config=backend.hcl
  backend "s3" {}
}

provider "digitalocean" {}
