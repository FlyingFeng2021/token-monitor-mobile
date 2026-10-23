package com.javis.tokenmonitor;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final int REQUEST_NOTIFICATIONS = 4701;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 本地插件须在 super.onCreate 前注册
        registerPlugin(TokenMonitorSsePlugin.class);
        super.onCreate(savedInstanceState);
        maybeRequestNotifications();
    }

    // Android 13（API 33）起通知属运行时权限。当前版本仅在应用内提醒，
    // 预先申请以便后续版本的限额到达通知开箱可用；拒绝不影响任何现有功能。
    private void maybeRequestNotifications() {
        if (Build.VERSION.SDK_INT >= 33
                && ActivityCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    REQUEST_NOTIFICATIONS);
        }
    }
}
