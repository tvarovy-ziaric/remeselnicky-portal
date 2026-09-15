variable "region" {
  description = "DigitalOcean region for every staging data-plane resource."
  type        = string
  default     = "fra1"

  validation {
    condition     = var.region == "fra1"
    error_message = "The approved staging proposal is bounded to fra1."
  }
}

variable "kubernetes_version" {
  description = "Exact currently supported DOKS version slug selected during the approved plan review."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+-do\\.[0-9]+$", var.kubernetes_version))
    error_message = "Use an exact DOKS version slug; latest is forbidden."
  }
}

variable "name_suffix" {
  description = "Short collision-resistant suffix allocated before the first plan."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{4,12}$", var.name_suffix))
    error_message = "name_suffix must contain 4-12 lowercase letters or digits."
  }
}

variable "vpc_ip_range" {
  description = "Dedicated non-overlapping RFC1918 staging range."
  type        = string
  default     = "10.42.0.0/20"

  validation {
    condition     = can(cidrnetmask(var.vpc_ip_range))
    error_message = "vpc_ip_range must be valid CIDR notation."
  }
}
