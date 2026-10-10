package br.santos.rota.nav;

import android.annotation.SuppressLint;
import android.content.Context;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Looper;
import br.santos.rota.nav.NavModel.Fix;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

/**
 * Localização contínua nativa: FusedLocationProviderClient (Google Play Services) quando disponível; senão LocationManager
 * (GPS + rede). O WebView NÃO é usado para navegação contínua.
 */
public final class LocationSource {
    public interface Listener { void onFix(Fix fix, String provider, boolean mock); void onError(String message); }

    private final Context ctx;
    private Listener listener;
    private LocationCallback fusedCb;
    private LocationListener gpsL, netL;
    private boolean running = false;
    private String backend = "nenhum";

    public LocationSource(Context ctx) { this.ctx = ctx.getApplicationContext(); }

    public boolean hasPlayServices() {
        try { return GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(ctx) == ConnectionResult.SUCCESS; } catch (Throwable t) { return false; }
    }

    public boolean gpsEnabled() {
        LocationManager lm = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
        try { return lm != null && (lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)); } catch (Exception e) { return false; }
    }

    public String backend() { return backend; }
    public boolean isRunning() { return running; }

    private static Fix toFix(Location l) {
        return new Fix(l.getLatitude(), l.getLongitude(), l.hasAccuracy() ? l.getAccuracy() : 999, l.hasSpeed() ? l.getSpeed() : -1,
            l.hasBearing() ? l.getBearing() : -1, System.currentTimeMillis() - Math.max(0, (android.os.SystemClock.elapsedRealtimeNanos() - l.getElapsedRealtimeNanos()) / 1_000_000L));
    }

    private static boolean isMock(Location l) {
        return android.os.Build.VERSION.SDK_INT >= 31 ? l.isMock() : l.isFromMockProvider();
    }

    /** `precise`: 1 s, alta precisão. `saver`: 3 s e deslocamento mínimo de 3 m (economia de bateria). */
    @SuppressLint("MissingPermission")
    public synchronized void start(boolean precise, Listener l) {
        stop();
        listener = l;
        long interval = precise ? 1000 : 3000;
        float minDist = precise ? 0f : 3f;
        try {
            if (hasPlayServices()) {
                backend = "fused";
                LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, interval).setMinUpdateIntervalMillis(interval / 2)
                    .setMinUpdateDistanceMeters(minDist).setWaitForAccurateLocation(false).build();
                fusedCb = new LocationCallback() {
                    @Override public void onLocationResult(LocationResult r) {
                        for (Location loc : r.getLocations()) if (listener != null) listener.onFix(toFix(loc), loc.getProvider(), isMock(loc));
                    }
                };
                LocationServices.getFusedLocationProviderClient(ctx).requestLocationUpdates(req, fusedCb, Looper.getMainLooper());
            } else {
                backend = "platform";
                LocationManager lm = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
                gpsL = new Plat();
                netL = new Plat();
                if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, interval, minDist, gpsL, Looper.getMainLooper());
                if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, interval * 2, minDist, netL, Looper.getMainLooper());
            }
            running = true;
        } catch (SecurityException se) {
            running = false;
            if (listener != null) listener.onError("Permissão de localização ausente.");
        } catch (Exception e) {
            running = false;
            if (listener != null) listener.onError("Falha ao iniciar a localização: " + e.getMessage());
        }
    }

    private final class Plat implements LocationListener {
        @Override public void onLocationChanged(Location loc) { if (listener != null) listener.onFix(toFix(loc), loc.getProvider(), isMock(loc)); }
        @Override public void onStatusChanged(String p, int s, Bundle e) { }
        @Override public void onProviderEnabled(String p) { }
        @Override public void onProviderDisabled(String p) { if (listener != null && !gpsEnabled()) listener.onError("GPS desligado."); }
    }

    public synchronized void stop() {
        try {
            if (fusedCb != null) LocationServices.getFusedLocationProviderClient(ctx).removeLocationUpdates(fusedCb);
            LocationManager lm = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
            if (gpsL != null) lm.removeUpdates(gpsL);
            if (netL != null) lm.removeUpdates(netL);
        } catch (Exception ignored) { }
        fusedCb = null; gpsL = null; netL = null; running = false;
    }
}
