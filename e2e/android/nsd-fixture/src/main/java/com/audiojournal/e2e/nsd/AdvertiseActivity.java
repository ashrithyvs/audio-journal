package com.audiojournal.e2e.nsd;

import android.app.Activity;
import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Bundle;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * Test-only advertiser. Start with:
 *   am start -n com.audiojournal.e2e.nsd/.AdvertiseActivity \
 *     --es services "name|nodeId|port|txtvers;name|nodeId|port|txtvers"
 * or `--ez stop true` to unregister everything. Registrations live as long as
 * the process. Logs "AJ_NSD registered <name>" for the harness.
 */
public final class AdvertiseActivity extends Activity {
  private static final String TAG = "AJ_NSD";
  private static final List<NsdManager.RegistrationListener> ACTIVE = new ArrayList<>();

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    handle();
    finish();
  }

  @Override
  protected void onNewIntent(android.content.Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    handle();
  }

  private void handle() {
    NsdManager nsd = (NsdManager) getApplicationContext().getSystemService(Context.NSD_SERVICE);
    synchronized (ACTIVE) {
      for (NsdManager.RegistrationListener listener : ACTIVE) {
        try {
          nsd.unregisterService(listener);
        } catch (IllegalArgumentException ignored) {
          // already unregistered
        }
      }
      ACTIVE.clear();
    }
    if (getIntent().getBooleanExtra("stop", false)) {
      Log.i(TAG, "stopped");
      return;
    }
    String services = getIntent().getStringExtra("services");
    if (services == null || services.isEmpty()) {
      return;
    }
    for (String spec : services.split(";")) {
      String[] parts = spec.split("\\|");
      NsdServiceInfo info = new NsdServiceInfo();
      info.setServiceName(parts[0]);
      info.setServiceType("_privateai._tcp");
      info.setPort(Integer.parseInt(parts[2]));
      info.setAttribute("txtvers", parts.length > 3 ? parts[3] : "1");
      info.setAttribute("node-id", parts[1]);
      info.setAttribute("proto", "1.0");
      info.setAttribute("pair", "open");
      final String name = parts[0];
      NsdManager.RegistrationListener listener = new NsdManager.RegistrationListener() {
        @Override public void onServiceRegistered(NsdServiceInfo registered) {
          Log.i(TAG, "registered " + name);
        }
        @Override public void onRegistrationFailed(NsdServiceInfo failed, int code) {
          Log.w(TAG, "failed " + name + " " + code);
        }
        @Override public void onServiceUnregistered(NsdServiceInfo removed) {}
        @Override public void onUnregistrationFailed(NsdServiceInfo removed, int code) {}
      };
      nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener);
      synchronized (ACTIVE) {
        ACTIVE.add(listener);
      }
    }
  }
}
