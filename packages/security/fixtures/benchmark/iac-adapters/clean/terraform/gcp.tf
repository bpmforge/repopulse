resource "google_compute_firewall" "ssh_internal" {
  name    = "ssh-internal"
  network = "default"
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
  source_ranges = ["10.0.0.0/8"]
}
