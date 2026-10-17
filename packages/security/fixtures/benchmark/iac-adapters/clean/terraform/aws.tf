resource "aws_security_group" "internal_ssh" {
  name = "internal-ssh"
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/8"]
  }
}

resource "aws_db_instance" "private_encrypted" {
  identifier          = "db1"
  engine              = "postgres"
  instance_class      = "db.t3.micro"
  allocated_storage   = 20
  publicly_accessible = false
  storage_encrypted   = true
}

resource "aws_s3_bucket" "private" {
  bucket = "example-private"
  acl    = "private"
}

resource "aws_iam_policy" "scoped" {
  name = "scoped"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = "arn:aws:s3:::example/*"
    }]
  })
}

provider "aws" {
  region = "us-east-1"
}

resource "aws_ebs_volume" "encrypted" {
  availability_zone = "us-east-1a"
  size              = 8
  encrypted         = true
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/x/y"
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = "arn:aws:acm:us-east-1:123456789012:certificate/abc"
  default_action {
    type             = "forward"
    target_group_arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/x/y"
  }
}
