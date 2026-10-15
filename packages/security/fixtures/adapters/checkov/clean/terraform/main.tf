# Near-miss of the triggering fixture: the same resources, configured safely.
resource "aws_security_group" "ssh" {
  name        = "ssh"
  description = "ssh from the office VPN only"

  ingress {
    description = "ssh"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["10.20.0.0/16"]
  }
}

resource "aws_db_instance" "main" {
  engine                      = "postgres"
  instance_class              = "db.t3.micro"
  allocated_storage           = 20
  username                    = "app"
  manage_master_user_password = true
  publicly_accessible         = false
  storage_encrypted           = true
}
