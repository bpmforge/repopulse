<?php
// The safe versions of the same jobs, and the near-misses an earlier draft
// flagged. Nothing in this file may produce a finding.

function find_user(PDO $pdo)
{
    $stmt = $pdo->prepare('SELECT * FROM users WHERE name = ?');
    $stmt->execute([$_GET['name']]);
    return $stmt->fetchAll();
}

function find_order($conn)
{
    $id = (int) $_GET['id'];
    return mysqli_query($conn, "SELECT * FROM orders WHERE id = " . $id);
}

function find_by_status($conn)
{
    $status = mysqli_real_escape_string($conn, $_POST['status']);
    return mysqli_query($conn, "SELECT * FROM orders WHERE status = '" . $status . "'");
}

function list_tables($db, $prefix)
{
    // A table prefix from configuration, not from the request.
    return $db->query("SELECT * FROM {$prefix}options");
}

function ping_host()
{
    return shell_exec('ping -c 1 ' . escapeshellarg($_REQUEST['host']));
}

function render_page()
{
    $allowed = ['home', 'about'];
    $page = in_array($_GET['page'], $allowed, true) ? $_GET['page'] : 'home';
    include __DIR__ . '/pages/' . basename($page) . '.php';
}

function restore_cart()
{
    return json_decode($_COOKIE['cart'], true);
}

function load_cache($file)
{
    return unserialize(file_get_contents($file));
}

function bootstrap($row)
{
    extract($_POST, EXTR_SKIP);
    extract($row);
}

function register($db, $user, $password)
{
    $db->insert('users', ['name' => $user, 'pw' => password_hash($password, PASSWORD_DEFAULT)]);
    $cache_key = md5($user);
    $policy = md5($password_policy_version);
}

function issue_reset($user)
{
    $token = bin2hex(random_bytes(32));
    $delay = mt_rand(100, 500);
    $user['color'] = array_rand(['red' => 1, 'blue' => 2]);
    return $token;
}

function fetch($url, $verify)
{
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, $verify);
    return curl_exec($ch);
}

function parse_feed($xml)
{
    $doc = new DOMDocument();
    $doc->loadXML($xml, LIBXML_NONET);
    return $doc;
}

function verify_webhook($payload, $signature, $secret)
{
    $expected_signature = hash_hmac('sha256', $payload, $secret);
    if ($signature == '') {
        return false;
    }
    if ($token == null) {
        return false;
    }
    return hash_equals($expected_signature, $signature);
}

function current_menu($menu)
{
    // A session value that is not a secret: a menu id.
    return $menu['rowid'] == $_SESSION['idmenu'];
}

function digest_ha1($username, $realm, $password)
{
    // HTTP Digest's HA1 is defined as MD5(user:realm:password).
    return md5($username . ':' . $realm . ':' . $password);
}
