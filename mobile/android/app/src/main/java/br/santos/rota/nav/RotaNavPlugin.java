package br.santos.rota.nav;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.view.WindowManager;
import androidx.core.content.ContextCompat;
import br.santos.rota.nav.NavModel.Fix;
import br.santos.rota.nav.NavModel.Maneuver;
import br.santos.rota.nav.NavModel.Route;
import br.santos.rota.nav.NavModel.StopPoint;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Ponte Capacitor ↔ sessão de navegação nativa. A lógica contínua (GPS, manobras, voz) roda em Java; o JS só envia a rota
 * e recebe eventos. Eventos produzidos com o WebView suspenso ficam em buffer e são entregues por {@code drain}.
 */
@CapacitorPlugin(name = "RotaNav", permissions = {
    @Permission(alias = "location", strings = {Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}),
    @Permission(alias = "notifications", strings = {"android.permission.POST_NOTIFICATIONS"}),
    @Permission(alias = "microphone", strings = {Manifest.permission.RECORD_AUDIO})
})
public class RotaNavPlugin extends Plugin {
    private SpeechRecognizer recognizer;

    private NavSession session() { return NavSession.get(getContext()); }

    @Override public void load() {
        // Eventos vão direto ao JS enquanto o app está visível; senão ficam no buffer da sessão.
        attachSink();
    }

    private void attachSink() {
        session().setSink((name, data) -> {
            if (!hasListeners(name) || !isActive()) {
                session().buffer(data);
                return;
            }
            notifyListeners(name, toJs(data));
        });
    }

    private boolean active = true;
    private boolean isActive() { return active; }
    @Override protected void handleOnResume() { active = true; }
    @Override protected void handleOnPause() { active = false; }

    private static JSObject toJs(JSONObject o) {
        try { return new JSObject(o.toString()); } catch (JSONException e) { return new JSObject(); }
    }

    private String perm(String alias) {
        return getPermissionState(alias).toString().toLowerCase();
    }

    private JSObject permissions() {
        JSObject r = new JSObject();
        r.put("location", perm("location"));
        r.put("notifications", Build.VERSION.SDK_INT >= 33 ? perm("notifications") : "granted");
        r.put("microphone", perm("microphone"));
        r.put("backgroundLocation", backgroundGranted() ? "granted" : "not-requested");
        return r;
    }

    private boolean backgroundGranted() {
        return Build.VERSION.SDK_INT >= 29 && ContextCompat.checkSelfPermission(getContext(), "android.permission.ACCESS_BACKGROUND_LOCATION") == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod public void checkPermissions(PluginCall call) { call.resolve(permissions()); }

    /** Pede só o necessário para navegar com a tela acesa/serviço em primeiro plano. NÃO pede localização em segundo plano. */
    @PluginMethod public void requestNavPermissions(PluginCall call) {
        List<String> need = new ArrayList<>();
        if (!perm("location").equals("granted")) need.add("location");
        if (Build.VERSION.SDK_INT >= 33 && !perm("notifications").equals("granted")) need.add("notifications");
        if (need.isEmpty()) { call.resolve(permissions()); return; }
        requestPermissionForAliases(need.toArray(new String[0]), call, "navPermsCallback");
    }

    @PermissionCallback private void navPermsCallback(PluginCall call) { call.resolve(permissions()); }

    @PluginMethod public void requestMicrophone(PluginCall call) {
        if (perm("microphone").equals("granted")) { call.resolve(permissions()); return; }
        requestPermissionForAlias("microphone", call, "navPermsCallback");
    }

    @PluginMethod public void status(PluginCall call) {
        NavSession s = session();
        JSObject r = new JSObject();
        r.put("navigating", s.isNavigating());
        r.put("paused", s.isPaused());
        r.put("backend", s.location().backend());
        r.put("playServices", s.location().hasPlayServices());
        r.put("gpsEnabled", s.location().gpsEnabled());
        r.put("sdk", Build.VERSION.SDK_INT);
        r.put("stopIndex", s.stopIndex());
        r.put("lastInstruction", s.isNavigating() ? s.lastInstruction() : "");
        r.put("permissions", permissions());
        call.resolve(r);
    }

    @PluginMethod public void configure(PluginCall call) {
        session().configure(call.getBoolean("speech", true), call.getBoolean("detailed", true), call.getBoolean("preciseGps", true),
            call.getBoolean("lockscreenManeuver", false), call.getFloat("rate", 1f), call.getFloat("volume", 1f));
        call.resolve();
    }

    static Route parseRoute(JSObject o) throws JSONException {
        JSONArray la = o.getJSONArray("lat"), lo = o.getJSONArray("lon");
        int n = Math.min(la.length(), lo.length());
        if (n < 2) throw new JSONException("rota sem geometria");
        double[] lat = new double[n], lon = new double[n];
        for (int i = 0; i < n; i++) { lat[i] = la.getDouble(i); lon[i] = lo.getDouble(i); }
        List<Maneuver> ms = new ArrayList<>();
        JSONArray ma = o.optJSONArray("maneuvers");
        for (int i = 0; ma != null && i < ma.length(); i++) {
            JSONObject m = ma.getJSONObject(i);
            ms.add(new Maneuver(m.optString("kind", "straight"), m.optString("street", ""), m.getDouble("lat"), m.getDouble("lon"), m.optDouble("at", 0)));
        }
        List<StopPoint> ss = new ArrayList<>();
        JSONArray sa = o.optJSONArray("stops");
        for (int i = 0; sa != null && i < sa.length(); i++) {
            JSONObject s = sa.getJSONObject(i);
            ss.add(new StopPoint(s.optString("key", String.valueOf(i)), s.optInt("seq", i + 1), s.getDouble("lat"), s.getDouble("lon"), s.optDouble("at", 0),
                s.optString("street", ""), s.optString("number", ""), s.optInt("letters", 1), s.optString("precision", "street")));
        }
        return new Route(lat, lon, ms, ss);
    }

    @PluginMethod public void startNavigation(PluginCall call) {
        if (!perm("location").equals("granted")) { call.reject("Permissão de localização não concedida.", "NO_LOCATION_PERMISSION"); return; }
        try {
            Route r = parseRoute(call.getData());
            NavForegroundService.start(getContext());
            session().start(r, call.getInt("stopIndex", 0));
            call.resolve(new JSObject().put("backend", session().location().backend()));
        } catch (Exception e) { call.reject("Rota inválida: " + e.getMessage()); }
    }

    @PluginMethod public void updateRoute(PluginCall call) {
        try { session().updateRoute(parseRoute(call.getData()), call.getInt("stopIndex", 0)); call.resolve(); }
        catch (Exception e) { call.reject("Rota inválida: " + e.getMessage()); }
    }

    @PluginMethod public void advanceStop(PluginCall call) { session().advanceStop(); call.resolve(); }
    @PluginMethod public void jumpToStop(PluginCall call) { session().jumpToStop(call.getInt("index", 0)); call.resolve(); }
    @PluginMethod public void pause(PluginCall call) { session().pause(); call.resolve(); }
    @PluginMethod public void resume(PluginCall call) { session().resume(); call.resolve(); }
    @PluginMethod public void repeat(PluginCall call) { session().repeat(); call.resolve(); }

    @PluginMethod public void stopNavigation(PluginCall call) {
        session().stop();
        NavForegroundService.stop(getContext());
        call.resolve();
    }

    @PluginMethod public void speak(PluginCall call) {
        String t = call.getString("text", "");
        if (t != null && !t.isEmpty()) session().speakTest(t);
        call.resolve();
    }

    /** Posição única/contínua sem rota (modo "seguir-me" do mapa). */
    @PluginMethod public void startLocation(PluginCall call) {
        if (!perm("location").equals("granted")) { call.reject("Permissão de localização não concedida.", "NO_LOCATION_PERMISSION"); return; }
        NavSession s = session();
        if (!s.isNavigating()) {
            s.location().start(call.getBoolean("preciseGps", true), new LocationSource.Listener() {
                @Override public void onFix(Fix f, String provider, boolean mock) { s.emitLocation(f, provider, mock); }
                @Override public void onError(String message) { s.emitError(message); }
            });
        }
        call.resolve(new JSObject().put("backend", s.location().backend()));
    }

    @PluginMethod public void stopLocation(PluginCall call) {
        NavSession s = session();
        if (!s.isNavigating()) s.location().stop();
        call.resolve();
    }

    @PluginMethod public void drain(PluginCall call) {
        JSArray arr = new JSArray();
        for (JSONObject o : session().drain()) arr.put(o);
        call.resolve(new JSObject().put("events", arr));
    }

    @PluginMethod public void setShowWhenLocked(PluginCall call) {
        boolean on = call.getBoolean("enabled", false);
        Activity a = getActivity();
        if (a == null) { call.reject("Sem atividade."); return; }
        a.runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= 27) { a.setShowWhenLocked(on); a.setTurnScreenOn(false); }
            else if (on) a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
            else a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
            call.resolve();
        });
    }

    @PluginMethod public void keepScreenOn(PluginCall call) {
        boolean on = call.getBoolean("enabled", false);
        Activity a = getActivity();
        if (a == null) { call.resolve(); return; }
        a.runOnUiThread(() -> {
            if (on) a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    /** Reconhecimento de voz SÓ quando o botão do microfone é tocado (nunca escuta em segundo plano). */
    @PluginMethod public void listenOnce(PluginCall call) {
        if (!perm("microphone").equals("granted")) { call.reject("Permissão de microfone não concedida.", "NO_MIC_PERMISSION"); return; }
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) { call.reject("Reconhecimento de voz indisponível neste aparelho.", "NO_RECOGNIZER"); return; }
        new Handler(Looper.getMainLooper()).post(() -> {
            if (recognizer != null) recognizer.destroy();
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onResults(Bundle b) {
                    ArrayList<String> r = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    call.resolve(new JSObject().put("text", r == null || r.isEmpty() ? "" : r.get(0)));
                    recognizer.destroy(); recognizer = null;
                }
                @Override public void onError(int code) { call.reject("Não entendi (" + code + ").", "RECOGNIZER_" + code); if (recognizer != null) { recognizer.destroy(); recognizer = null; } }
                @Override public void onReadyForSpeech(Bundle p) { }
                @Override public void onBeginningOfSpeech() { }
                @Override public void onRmsChanged(float v) { }
                @Override public void onBufferReceived(byte[] b) { }
                @Override public void onEndOfSpeech() { }
                @Override public void onPartialResults(Bundle b) { }
                @Override public void onEvent(int t, Bundle b) { }
            });
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "pt-BR").putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            recognizer.startListening(i);
        });
    }

    @Override protected void handleOnDestroy() { if (recognizer != null) recognizer.destroy(); }
}
