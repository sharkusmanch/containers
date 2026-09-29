<?php
// Read by tachyon/v/<version>/include.php before anything else.
//
// Data lives outside the web root, on the mounted volume.
define('APP_DATA_FOLDER_PATH', '/var/lib/tachyon/');
// An overlay read on EVERY config load, on top of application.ini, and never
// written back by Tachyon (Config\AbstractConfig::Load). tachyon-init points it
// at a mounted file, so the settings that matter are kept outside the app's
// own mutable application.ini.
define('APP_CONFIGURATION_NAME', 'overrides.ini');
