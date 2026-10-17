# expect: tool.checkov.CKV_AWS_24
resource "aws_security_group" "ssh_open" {
  name = "ssh-open"
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# expect: tool.checkov.CKV_AWS_25
resource "aws_security_group" "rdp_open" {
  name = "rdp-open"
  ingress {
    from_port   = 3389
    to_port     = 3389
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# expect: tool.checkov.CKV_AWS_277 tool.checkov.CKV_AWS_260 tool.checkov.CKV_AWS_24 tool.checkov.CKV_AWS_25
resource "aws_security_group" "all_open" {
  name = "all-open"
  ingress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# expect: tool.checkov.CKV_AWS_17 tool.checkov.CKV_AWS_16
resource "aws_db_instance" "public_unencrypted" {
  identifier          = "db1"
  engine              = "postgres"
  instance_class      = "db.t3.micro"
  allocated_storage   = 20
  publicly_accessible = true
  storage_encrypted   = false
}

# expect: tool.checkov.CKV_AWS_20
resource "aws_s3_bucket" "public_read" {
  bucket = "example-public-read"
  acl    = "public-read"
}

# expect: tool.checkov.CKV_AWS_57 tool.checkov.CKV_AWS_20
resource "aws_s3_bucket" "public_write" {
  bucket = "example-public-write"
  acl    = "public-read-write"
}

# expect: tool.checkov.CKV_AWS_63 tool.checkov.CKV_AWS_287
resource "aws_iam_policy" "wildcard_action" {
  name = "wildcard"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "*"
      Resource = "arn:aws:s3:::example"
    }]
  })
}

# expect: tool.checkov.CKV_AWS_41
provider "aws" {
  region     = "us-east-1"
  access_key = "AKIAIOSFODNN7EXAMPLE"
  secret_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
}

# expect: tool.checkov.CKV_AWS_3
resource "aws_ebs_volume" "unencrypted" {
  availability_zone = "us-east-1a"
  size              = 8
  encrypted         = false
}

# expect: tool.checkov.CKV_AWS_2 tool.checkov.CKV_AWS_103
resource "aws_lb_listener" "http" {
  load_balancer_arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/x/y"
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/x/y"
  }
}
