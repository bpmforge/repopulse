# expect: tool.checkov.CKV_GCP_2
resource "google_compute_firewall" "ssh_open" {
  name    = "ssh-open"
  network = "default"
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
  source_ranges = ["0.0.0.0/0"]
}

# expect: tool.checkov.CKV_GCP_3
resource "google_compute_firewall" "rdp_open" {
  name    = "rdp-open"
  network = "default"
  allow {
    protocol = "tcp"
    ports    = ["3389"]
  }
  source_ranges = ["0.0.0.0/0"]
}
