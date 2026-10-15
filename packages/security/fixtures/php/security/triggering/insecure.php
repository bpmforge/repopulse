<?php
// Every construct below is one the PHP security rules must flag. Each expected
// finding is announced by a `ruleid:` comment on the line above it.

function find_user($conn)
{
    $name = $_GET['name'];
    $sql = "SELECT * FROM users WHERE name = '" . $name . "'";
    // ruleid: bpm-php-sql-from-request
    return mysqli_query($conn, $sql);
}

function delete_post(PDO $pdo)
{
    // ruleid: bpm-php-sql-from-request
    $pdo->exec("DELETE FROM posts WHERE slug = '{$_POST['slug']}'");
}

function ping_host()
{
    $host = $_REQUEST['host'];
    // ruleid: bpm-php-command-from-request
    return shell_exec("ping -c 1 " . $host);
}

function render_page()
{
    $page = $_GET['page'];
    // ruleid: bpm-php-code-from-request
    include $page . '.php';
}

function calc()
{
    // ruleid: bpm-php-code-from-request
    eval('return ' . $_POST['expr'] . ';');
}

function restore_cart()
{
    // ruleid: bpm-php-unserialize-request
    return unserialize(base64_decode($_COOKIE['cart']));
}

function bootstrap()
{
    // ruleid: bpm-php-extract-request
    extract($_POST);
}

function register($db, $user, $password)
{
    // ruleid: bpm-php-weak-hash-password
    $hash = md5($password);
    $db->insert('users', ['name' => $user, 'pw' => $hash]);
}

function check_login($row, $user)
{
    // ruleid: bpm-php-weak-hash-password
    return hash('sha1', $user['password']) === $row['pw'];
}

function issue_reset($user)
{
    // ruleid: bpm-php-insecure-random-token
    $token = md5(uniqid(mt_rand(), true));
    // ruleid: bpm-php-insecure-random-token
    $user['api_key'] = substr(str_shuffle('abcdefghijklmnopqrstuvwxyz0123456789'), 0, 32);
    return $token;
}

function fetch($url)
{
    $ch = curl_init($url);
    // ruleid: bpm-php-tls-verify-disabled
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    // ruleid: bpm-php-tls-verify-disabled
    curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0);
    return curl_exec($ch);
}

function fetch_stream($url)
{
    $context = stream_context_create([
        // ruleid: bpm-php-tls-verify-disabled
        'ssl' => ['verify_peer' => false, 'verify_peer_name' => false],
    ]);
    return file_get_contents($url, false, $context);
}

function parse_feed($xml)
{
    $doc = new DOMDocument();
    // ruleid: bpm-php-xml-entity-expansion
    $doc->loadXML($xml, LIBXML_NOENT | LIBXML_NONET);
    return $doc;
}

function verify_webhook($payload, $signature, $secret)
{
    $expected_signature = hash_hmac('sha256', $payload, $secret);
    // ruleid: bpm-php-secret-loose-compare
    return $expected_signature == $signature;
}

function check_csrf()
{
    // ruleid: bpm-php-secret-loose-compare
    return $_POST['csrf'] == $_SESSION['csrf_token'];
}
