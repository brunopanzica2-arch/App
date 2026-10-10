package br.santos.rota.nav;

import android.content.Context;
import android.os.PowerManager;
import br.santos.rota.nav.NavModel.Event;
import br.santos.rota.nav.NavModel.Fix;
import br.santos.rota.nav.NavModel.Route;
import br.santos.rota.nav.NavModel.State;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Sessão de navegação única do processo: motor + localização + voz. Vive no processo do app, independente do WebView
 * (que pode ficar suspenso com a tela apagada). O serviço em primeiro plano mantém o processo vivo.
 */
public final class NavSession {
    public interface Sink { void emit(String name, JSONObject data); }

    private static NavSession instance;
    public static synchronized NavSession get(Context c) {
        if (instance == null) instance = new NavSession(c.getApplicationContext());
        return instance;
    }

    private final Context ctx;
    private final LocationSource loc;
    private TtsController tts;
    private NavigationEngine engine;
    private Route route;
    private Sink sink;
    private PowerManager.WakeLock wake;
    private boolean navigating = false, paused = false, precise = true, speech = true, lockscreenManeuver = false;
    private State lastState;
    private String lastInstruction = "";
    private final List<JSONObject> backlog = new ArrayList<>();
    private Runnable stateListener;

    private NavSession(Context c) { ctx = c; loc = new LocationSource(c); }

    public LocationSource location() { return loc; }
    public boolean isNavigating() { return navigating; }
    public boolean isPaused() { return paused; }
    public State lastState() { return lastState; }
    public String lastInstruction() { return lastInstruction; }
    public boolean lockscreenManeuver() { return lockscreenManeuver; }
    public void setSink(Sink s) { sink = s; }
    public void setStateListener(Runnable r) { stateListener = r; }
    public TtsController tts() {
        if (tts == null) tts = new TtsController(ctx, new TtsController.Callback() {
            @Override public void onDone(String id) { }
            @Override public void onReady(boolean ok, String reason) { emit("tts", json("ready", ok, "reason", reason)); }
        });
        return tts;
    }

    static JSONObject json(Object... kv) {
        JSONObject o = new JSONObject();
        try { for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]); } catch (JSONException ignored) { }
        return o;
    }

    /** Entrega direta ao buffer quando o WebView não está ouvindo. */
    public synchronized void buffer(JSONObject data) { backlog.add(data); while (backlog.size() > 60) backlog.remove(0); }

    public void emitLocation(Fix fix, String provider, boolean mock) {
        emit("location", json("lat", fix.lat, "lon", fix.lon, "accuracy", fix.accuracy, "speed", fix.speed, "bearing", fix.bearing,
            "time", fix.timeMs, "provider", provider == null ? "" : provider, "mock", mock));
    }
    public void emitError(String message) { emit("locationError", json("message", message)); }

    private synchronized void emit(String name, JSONObject data) {
        try { data.put("_event", name); } catch (JSONException ignored) { }
        if (sink != null) sink.emit(name, data);
        else { backlog.add(data); while (backlog.size() > 60) backlog.remove(0); }
    }

    /** Eventos acumulados enquanto o WebView estava suspenso (tela apagada). */
    public synchronized List<JSONObject> drain() { List<JSONObject> r = new ArrayList<>(backlog); backlog.clear(); return r; }

    public synchronized void configure(boolean speechOn, boolean detailed, boolean preciseGps, boolean lockscreenManeuverText, float rate, float volume) {
        speech = speechOn;
        precise = preciseGps;
        lockscreenManeuver = lockscreenManeuverText;
        TtsController t = tts();
        t.setEnabled(speechOn);
        t.setRate(rate);
        t.setVolume(volume);
        if (engine != null) { /* Config é lida no início; troca de detalhe vale para a próxima rota */ }
        pendingDetailed = detailed;
    }
    private boolean pendingDetailed = true;

    @SuppressWarnings("MissingPermission")
    public synchronized void start(Route r, int stopIndex) {
        stopInternal(false);
        route = r;
        NavigationEngine.Config c = new NavigationEngine.Config();
        c.detailed = pendingDetailed;
        engine = new NavigationEngine(r, c);
        engine.jumpToStop(stopIndex);
        navigating = true;
        paused = false;
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        if (pm != null && (wake == null || !wake.isHeld())) {
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "rotasantos:nav");
            wake.acquire(6 * 60 * 60 * 1000L);
        }
        tts();
        loc.start(precise, new LocationSource.Listener() {
            @Override public void onFix(Fix fix, String provider, boolean mock) { handleFix(fix, provider, mock); }
            @Override public void onError(String message) { emit("locationError", json("message", message)); }
        });
        emit("navigation", json("status", "started", "stops", r.stops.size(), "meters", r.length()));
    }

    /** Nova geometria após recálculo (desvio, nova ordem): mantém a parada atual. */
    public synchronized void updateRoute(Route r, int stopIndex) {
        if (!navigating) return;
        route = r;
        NavigationEngine.Config c = new NavigationEngine.Config();
        c.detailed = pendingDetailed;
        engine = new NavigationEngine(r, c);
        engine.jumpToStop(stopIndex);
        engine.setPaused(paused);
        emit("navigation", json("status", "rerouted", "stops", r.stops.size(), "meters", r.length()));
    }

    private void handleFix(Fix fix, String provider, boolean mock) {
        emitLocation(fix, provider, mock);
        NavigationEngine e = engine;
        if (!navigating || e == null) return;
        for (Event ev : e.onFix(fix)) {
            switch (ev.type) {
                case STATE:
                    lastState = ev.state;
                    emit("navState", stateJson(ev.state));
                    if (stateListener != null) stateListener.run();
                    break;
                case SPEAK:
                    lastInstruction = ev.text;
                    speakNow(ev);
                    emit("instruction", json("text", ev.text, "id", ev.id));
                    break;
                case NEAR_STOP:
                    lastInstruction = ev.text;
                    speakNow(ev);
                    emit("nearStop", json("stopKey", ev.stopKey, "text", ev.text));
                    break;
                case OFF_ROUTE:
                    speakNow(ev);
                    emit("offRoute", json("lat", fix.lat, "lon", fix.lon, "stopIndex", e.currentStopIndex()));
                    break;
                case BACK_ON_ROUTE:
                    emit("backOnRoute", new JSONObject());
                    break;
                case ROUTE_END:
                    speakNow(ev);
                    emit("routeEnd", new JSONObject());
                    break;
            }
        }
    }

    private void speakNow(Event ev) { if (speech && !paused) tts().speak(ev.text, ev.urgent, ev.id); }

    static JSONObject stateJson(State s) {
        return json("progress", s.progress, "total", s.total, "accuracy", s.accuracy, "speed", s.speed, "lateral", s.lateral, "offRoute", s.offRoute,
            "lowAccuracy", s.lowAccuracy, "paused", s.paused, "nextKind", s.nextKind, "nextStreet", s.nextStreet, "nextDist", s.nextDist,
            "stopKey", s.stopKey, "stopSeq", s.stopSeq, "stopDist", s.stopDist, "stopsLeft", s.stopsLeft);
    }

    public synchronized void advanceStop() { if (engine != null) engine.advanceStop(); }
    public synchronized void jumpToStop(int idx) { if (engine != null) engine.jumpToStop(idx); }
    public synchronized int stopIndex() { return engine == null ? 0 : engine.currentStopIndex(); }

    public synchronized void pause() {
        paused = true;
        if (engine != null) engine.setPaused(true);
        if (tts != null) tts.stop();
        emit("navigation", json("status", "paused"));
        if (stateListener != null) stateListener.run();
    }

    public synchronized void resume() {
        paused = false;
        if (engine != null) engine.setPaused(false);
        emit("navigation", json("status", "resumed"));
        if (stateListener != null) stateListener.run();
    }

    public synchronized void repeat() {
        if (engine == null) return;
        Event ev = engine.repeat();
        if (ev != null && speech) tts().speak(ev.text, true, "repeat");
    }

    public synchronized void speakTest(String text) { tts().speak(text, true, "test"); }

    public synchronized void stop() { stopInternal(true); }

    private void stopInternal(boolean notify) {
        boolean was = navigating;
        navigating = false;
        paused = false;
        loc.stop();
        if (tts != null) tts.stop();
        if (wake != null && wake.isHeld()) wake.release();
        engine = null;
        if (notify && was) emit("navigation", json("status", "stopped"));
    }
}
