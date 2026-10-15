resource "aws_security_group" "ssh" {
  name        = "ssh"
  description = "ssh from anywhere"

  ingress {
    description = "ssh"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_instance" "main" {
  engine              = "postgres"
  instance_class      = "db.t3.micro"
  allocated_storage   = 20
  username            = "admin"
  password            = "hunter2hunter2"
  publicly_accessible = true
  storage_encrypted   = false
}
