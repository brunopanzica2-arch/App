package br.santos.rota.nav;

import br.santos.rota.nav.NavModel.Event;
import br.santos.rota.nav.NavModel.Fix;
import br.santos.rota.nav.NavModel.Maneuver;
import br.santos.rota.nav.NavModel.Route;
import br.santos.rota.nav.NavModel.State;
import br.santos.rota.nav.NavModel.StopPoint;
import br.santos.rota.nav.NavModel.Type;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Motor de navegação a pé: acompanha o progresso do usuário sobre a rota, decide O QUE falar e QUANDO, e detecta desvio.
 * Todo texto sai de manobras e paradas REAIS da rota (nunca de um modelo generativo). Roda em Java puro para continuar
 * funcionando com a tela apagada (o WebView pode ficar suspenso) e para ser testado na JVM.
 */
public final class NavigationEngine {
    /** Parâmetros ajustáveis (valores de partida para caminhada urbana; calibrar em campo). */
    public static final class Config {
        public double offRouteMinM = 30, offRouteAccuracyFactor = 1.5;
        public int offRouteFixes = 3;
        public long offRouteMinMs = 6000, offRouteSuppressMs = 20000, minSpeakGapMs = 3000;
        public double maxUsableAccuracyM = 60, nowM = 15, nearStopM = 25, nextStopAnnounceM = 100, stopPassedM = 40;
        public double minLegForFarM = 120;
        public boolean detailed = true; // false = só "agora vire…"
    }

    private final Route route;
    private final Config cfg;
    private final Set<String> announced = new HashSet<>();
    private int segHint = 0;
    private double progress = 0;
    private int offCount = 0;
    private long offSince = -1, suppressUntil = 0, lastSpeakAt = -100000, lastStateAt = -100000;
    private boolean wasOff = false, paused = false, ended = false;
    private int stopIdx = 0;
    private double speedEma = 1.2;
    private Fix prev;
    private String lastText = "";

    public NavigationEngine(Route route, Config cfg) {
        this.route = route;
        this.cfg = cfg == null ? new Config() : cfg;
    }

    public double progress() { return progress; }
    public int currentStopIndex() { return stopIdx; }
    public String lastInstruction() { return lastText; }
    public void setPaused(boolean p) { paused = p; }

    /** O usuário registrou a parada: passa para a seguinte. */
    public void advanceStop() {
        if (stopIdx < route.stops.size()) stopIdx++;
    }

    public void jumpToStop(int idx) {
        stopIdx = Math.max(0, Math.min(idx, route.stops.size()));
        for (int i = 0; i < stopIdx; i++) { announced.add("s" + i + ":next"); announced.add("s" + i + ":near"); }
    }

    /** Repete a última instrução (botão/voz/notificação). */
    public Event repeat() {
        return lastText.isEmpty() ? null : new Event(Type.SPEAK, lastText, true, null, "repeat", null);
    }

    private static String capFirst(String t) { return t.isEmpty() ? t : Character.toUpperCase(t.charAt(0)) + t.substring(1); }

    private static double clamp(double v, double lo, double hi) { return Math.max(lo, Math.min(hi, v)); }

    private String phrase(Maneuver m) {
        switch (m.kind) {
            case "left": return "vire à esquerda";
            case "right": return "vire à direita";
            case "slight_left": return "mantenha-se à esquerda";
            case "slight_right": return "mantenha-se à direita";
            case "sharp_left": return "faça uma curva fechada à esquerda";
            case "sharp_right": return "faça uma curva fechada à direita";
            case "uturn": return "faça o retorno";
            case "depart": return "siga em frente";
            default: return "continue em frente";
        }
    }

    private String onStreet(Maneuver m) {
        if (m.street.isEmpty()) return "";
        String spoken = PtBr.street(m.street);
        return " " + PtBr.inStreet(spoken);
    }

    public List<Event> onFix(Fix f) {
        List<Event> out = new ArrayList<>();
        if (ended) return out;
        double dt = prev == null ? 0 : (f.timeMs - prev.timeMs) / 1000.0;
        if (f.speed >= 0) speedEma = 0.7 * speedEma + 0.3 * f.speed;
        else if (prev != null && dt > 0.5) speedEma = 0.7 * speedEma + 0.3 * (Geo.distance(prev.lat, prev.lon, f.lat, f.lon) / dt);
        prev = f;

        State st = new State();
        st.total = route.length();
        st.accuracy = f.accuracy;
        st.speed = speedEma;
        st.paused = paused;
        st.stopsLeft = route.stops.size() - stopIdx;

        if (f.accuracy > cfg.maxUsableAccuracyM) {
            st.lowAccuracy = true;
            st.progress = progress;
            fillNext(st);
            maybeState(out, f, st, true);
            return out;
        }

        // 1) progresso: janela à frente do último segmento (evita "teletransporte" para ruas paralelas)
        int n = route.lat.length;
        Geo.Projection p = Geo.project(route.lat, route.lon, route.cum, f.lat, f.lon, segHint - 3, segHint + 80);
        double offT = Math.max(cfg.offRouteMinM, f.accuracy * cfg.offRouteAccuracyFactor);
        if (p.lateral > offT) {
            Geo.Projection g = Geo.project(route.lat, route.lon, route.cum, f.lat, f.lon, 0, n - 2);
            if (g.lateral < p.lateral * 0.6) p = g; // reencontrou a rota em outro trecho
        }
        st.lateral = p.lateral;
        boolean onRoute = p.lateral <= offT;
        if (onRoute) {
            if (p.along >= progress - 15) progress = Math.max(progress, p.along);
            segHint = p.segment;
            offCount = 0;
            offSince = -1;
            if (wasOff && p.lateral < offT * 0.7) {
                wasOff = false;
                out.add(new Event(Type.BACK_ON_ROUTE, "", false, null, "back", null));
            }
        } else {
            if (offCount == 0) offSince = f.timeMs;
            offCount++;
            if (offCount >= cfg.offRouteFixes && f.timeMs - offSince >= cfg.offRouteMinMs && f.timeMs >= suppressUntil) {
                wasOff = true;
                suppressUntil = f.timeMs + cfg.offRouteSuppressMs;
                speak(out, f, "Você saiu do caminho. Recalculando a rota.", true, "off:" + f.timeMs, Type.OFF_ROUTE, null);
            }
        }
        st.offRoute = wasOff && !onRoute;
        st.progress = progress;

        if (onRoute && !paused) {
            announceManeuvers(out, f);
            announceStops(out, f);
            if (stopIdx >= route.stops.size() && progress >= route.length() - cfg.nowM && !announced.contains("end")) {
                announced.add("end");
                ended = true;
                speak(out, f, "Você concluiu a rota.", true, "end", Type.ROUTE_END, null);
            }
        }
        fillNext(st);
        maybeState(out, f, st, false);
        return out;
    }

    private void fillNext(State st) {
        Maneuver m = nextManeuver();
        if (m != null) { st.nextKind = m.kind; st.nextStreet = m.street; st.nextDist = Math.max(0, m.at - progress); }
        if (stopIdx < route.stops.size()) {
            StopPoint s = route.stops.get(stopIdx);
            st.stopKey = s.key; st.stopSeq = s.seq;
            st.stopDist = prev == null ? -1 : Geo.distance(prev.lat, prev.lon, s.lat, s.lon);
        }
    }

    private void maybeState(List<Event> out, Fix f, State st, boolean force) {
        if (force || f.timeMs - lastStateAt >= 900) {
            lastStateAt = f.timeMs;
            out.add(new Event(Type.STATE, "", false, null, "state", st));
        }
    }

    private Maneuver nextManeuver() {
        for (Maneuver m : route.maneuvers) if (m.at > progress - 8 && !announced.contains("done:" + m.at)) return m;
        return null;
    }

    private void announceManeuvers(List<Event> out, Fix f) {
        Maneuver m = nextManeuver();
        if (m == null) return;
        if (progress >= m.at + 10) { announced.add("done:" + m.at); return; }
        double dist = m.at - progress;
        int idx = route.maneuvers.indexOf(m);
        double prevAt = idx > 0 ? route.maneuvers.get(idx - 1).at : 0;
        double farM = clamp(speedEma * 70, 100, 200);
        // estágios do mais distante ao mais próximo
        double[] thr = {farM, 50, Math.max(cfg.nowM, Math.min(25, f.accuracy * 0.7))};
        int eligible = -1;
        for (int i = 0; i < thr.length; i++) if (dist <= thr[i]) eligible = i;
        if (eligible < 0) return;
        boolean legLongEnough = (m.at - prevAt) >= cfg.minLegForFarM;
        if (!cfg.detailed && eligible < 2) return;
        if (eligible == 0 && !legLongEnough) return;
        String key = "m" + m.at + ":" + eligible;
        if (announced.contains(key)) return;
        String text;
        boolean urgent = eligible == 2;
        if (eligible == 2) text = "Agora, " + phrase(m) + onStreet(m) + ".";
        else text = "Em " + PtBr.distance(dist) + ", " + phrase(m) + onStreet(m) + ".";
        if (speak(out, f, text, urgent, key, Type.SPEAK, null)) {
            for (int i = 0; i <= eligible; i++) announced.add("m" + m.at + ":" + i);
        }
    }

    private void announceStops(List<Event> out, Fix f) {
        if (stopIdx >= route.stops.size()) return;
        StopPoint s = route.stops.get(stopIdx);
        double direct = Geo.distance(f.lat, f.lon, s.lat, s.lon);
        String street = PtBr.street(s.street);
        String cartas = s.letters == 1 ? "Uma carta." : capFirst(PtBr.number(s.letters)) + " cartas.";
        if (!announced.contains("s" + stopIdx + ":next") && (s.at - progress <= cfg.nextStopAnnounceM || direct <= cfg.nextStopAnnounceM)) {
            String text = "A próxima entrega é " + PtBr.inStreet(street)
                + ", número " + PtBr.houseNumber(s.number) + ". " + cartas;
            if (speak(out, f, text, false, "s" + stopIdx + ":next", Type.SPEAK, null)) announced.add("s" + stopIdx + ":next");
        }
        if (!announced.contains("s" + stopIdx + ":near") && direct <= Math.max(cfg.nearStopM, f.accuracy)) {
            String text = s.confirmedPosition()
                ? "Você chegou ao número " + PtBr.houseNumber(s.number) + ". Confirme a entrega."
                : "Você está próximo do número " + PtBr.houseNumber(s.number) + ". Confira o endereço.";
            if (speak(out, f, text, true, "s" + stopIdx + ":near", Type.NEAR_STOP, s.key)) announced.add("s" + stopIdx + ":near");
        }
    }

    /** Emite fala respeitando intervalo mínimo e urgência. Devolve false quando adiada (será tentada de novo no próximo fix). */
    private boolean speak(List<Event> out, Fix f, String text, boolean urgent, String id, Type type, String stopKey) {
        if (!urgent && f.timeMs - lastSpeakAt < cfg.minSpeakGapMs) return false;
        lastSpeakAt = f.timeMs;
        lastText = text;
        out.add(new Event(type, text, urgent, stopKey, id, null));
        return true;
    }
}
