package br.santos.rota.nav;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import br.santos.rota.nav.NavModel.Event;
import br.santos.rota.nav.NavModel.Fix;
import br.santos.rota.nav.NavModel.Maneuver;
import br.santos.rota.nav.NavModel.Route;
import br.santos.rota.nav.NavModel.StopPoint;
import br.santos.rota.nav.NavModel.Type;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/** Caminhada simulada sobre uma rota sintética em "L": 300 m a leste, 200 m ao sul, 150 m a leste. */
public class NavigationEngineTest {
    static final double LAT0 = -23.9500, LON0 = -46.3300;
    static double dLat(double m) { return m / 111320.0; }
    static double dLon(double m) { return m / (111320.0 * Math.cos(Math.toRadians(LAT0))); }

    /** ponto a `along` metros do início da rota, com deslocamento lateral `side` (m, + = direita do sentido de caminhada). */
    static double[] at(double along, double side) {
        if (along <= 300) return new double[]{LAT0 - dLat(side), LON0 + dLon(along)};                 // leste; direita = sul
        if (along <= 500) return new double[]{LAT0 - dLat(along - 300), LON0 + dLon(300) - dLon(side)}; // sul; direita = oeste
        return new double[]{LAT0 - dLat(200) + dLat(side), LON0 + dLon(300 + (along - 500))};           // leste; direita = sul
    }

    static Route route() {
        List<double[]> pts = new ArrayList<>();
        for (double a = 0; a <= 650; a += 10) pts.add(at(a, 0));
        double[] lat = new double[pts.size()], lon = new double[pts.size()];
        for (int i = 0; i < pts.size(); i++) { lat[i] = pts.get(i)[0]; lon[i] = pts.get(i)[1]; }
        List<Maneuver> ms = new ArrayList<>();
        ms.add(new Maneuver("depart", "Rua A", at(0, 0)[0], at(0, 0)[1], 0));
        ms.add(new Maneuver("right", "Rua B", at(300, 0)[0], at(300, 0)[1], 300));
        ms.add(new Maneuver("left", "Av. Cons. Nébias", at(500, 0)[0], at(500, 0)[1], 500));
        List<StopPoint> ss = new ArrayList<>();
        ss.add(new StopPoint("K1", 1, at(420, 0)[0], at(420, 0)[1], 420, "Rua B", "118", 3, "entrance"));
        ss.add(new StopPoint("K2", 2, at(650, 0)[0], at(650, 0)[1], 650, "Av. Cons. Nébias", "20", 1, "interpolated"));
        return new Route(lat, lon, ms, ss);
    }

    /** caminha de `from` a `to` m a 1,4 m/s, um fix por segundo; `side` desloca lateralmente. */
    static List<Event> walk(NavigationEngine e, double from, double to, double side, double acc, long t0, List<Long> clock) {
        List<Event> all = new ArrayList<>();
        long t = t0;
        for (double a = from; a <= to; a += 1.4) {
            double[] p = at(a, side);
            all.addAll(e.onFix(new Fix(p[0], p[1], acc, 1.4, -1, t)));
            t += 1000;
        }
        clock.add(t);
        return all;
    }

    static List<String> speech(List<Event> ev) {
        List<String> o = new ArrayList<>();
        for (Event e : ev) if (e.type == Type.SPEAK || e.type == Type.NEAR_STOP || e.type == Type.ROUTE_END || e.type == Type.OFF_ROUTE) o.add(e.text);
        return o;
    }

    @Test public void announcesManeuversInOrderOnceEach() {
        NavigationEngine e = new NavigationEngine(route(), null);
        List<Long> clk = new ArrayList<>();
        List<String> say = speech(walk(e, 0, 330, 0, 8, 1_000_000, clk));
        assertEquals("Agora, siga em frente na Rua A.", say.get(0));
        assertTrue(say.toString(), say.contains("Em cem metros, vire à direita na Rua B."));
        assertTrue(say.toString(), say.contains("Em cinquenta metros, vire à direita na Rua B."));
        assertTrue(say.toString(), say.contains("Agora, vire à direita na Rua B."));
        int idx100 = say.indexOf("Em cem metros, vire à direita na Rua B."), idx50 = say.indexOf("Em cinquenta metros, vire à direita na Rua B."), now = say.indexOf("Agora, vire à direita na Rua B.");
        assertTrue(idx100 < idx50 && idx50 < now);
        // nunca repete a mesma instrução
        assertEquals(say.size(), new java.util.HashSet<>(say).size());
    }

    @Test public void stopAnnouncementsAndArrivalWording() {
        NavigationEngine e = new NavigationEngine(route(), null);
        List<Long> clk = new ArrayList<>();
        List<Event> ev = walk(e, 0, 440, 0, 8, 1_000_000, clk);
        List<String> say = speech(ev);
        assertTrue(say.toString(), say.contains("A próxima entrega é na Rua B, número cento e dezoito. Três cartas."));
        // posição de portaria confirmada: pode dizer "chegou", mas pede confirmação manual
        assertTrue(say.toString(), say.contains("Você chegou ao número cento e dezoito. Confirme a entrega."));
        boolean near = false;
        for (Event x : ev) if (x.type == Type.NEAR_STOP && "K1".equals(x.stopKey)) near = true;
        assertTrue(near);
        assertEquals(0, e.currentStopIndex()); // aproximar NÃO entrega: só o usuário avança
        e.advanceStop();
        List<String> more = speech(walk(e, 440, 650, 0, 8, clk.get(0), new ArrayList<>()));
        assertTrue(more.toString(), more.contains("A próxima entrega é na Avenida Conselheiro Nébias, número vinte. Uma carta."));
        // ponto interpolado: NUNCA diz que chegou à portaria
        assertTrue(more.toString(), more.contains("Você está próximo do número vinte. Confira o endereço."));
        assertFalse(more.toString().contains("Você chegou ao número vinte"));
        e.advanceStop();
        List<String> end = speech(walk(e, 650, 650, 0, 8, clk.get(0) + 300_000, new ArrayList<>()));
        assertTrue(end.toString(), end.contains("Você concluiu a rota."));
    }

    @Test public void jitterDoesNotTriggerOffRoute() {
        NavigationEngine e = new NavigationEngine(route(), null);
        java.util.Random r = new java.util.Random(7);
        long t = 1_000_000;
        int off = 0;
        for (double a = 0; a <= 300; a += 1.4) {
            double[] p = at(a, (r.nextDouble() - 0.5) * 20); // ±10 m de ruído, precisão informada 15 m
            for (Event ev : e.onFix(new Fix(p[0], p[1], 15, 1.4, -1, t))) if (ev.type == Type.OFF_ROUTE) off++;
            t += 1000;
        }
        assertEquals(0, off);
    }

    @Test public void realDeviationFiresOnceThenBackOnRoute() {
        NavigationEngine e = new NavigationEngine(route(), null);
        List<Long> clk = new ArrayList<>();
        walk(e, 0, 100, 0, 8, 1_000_000, clk);
        long t = clk.get(0);
        int offs = 0, backs = 0;
        // 90 m para o lado, durante 15 s
        for (int i = 0; i < 15; i++) {
            double[] p = at(100, 90);
            for (Event ev : e.onFix(new Fix(p[0], p[1], 8, 1.4, -1, t))) { if (ev.type == Type.OFF_ROUTE) offs++; }
            t += 1000;
        }
        assertEquals("um único aviso de desvio (histerese/supressão)", 1, offs);
        double[] p = at(110, 0);
        for (Event ev : e.onFix(new Fix(p[0], p[1], 8, 1.4, -1, t))) if (ev.type == Type.BACK_ON_ROUTE) backs++;
        assertEquals(1, backs);
    }

    @Test public void lowAccuracyFixesAreIgnoredAndFlagged() {
        NavigationEngine e = new NavigationEngine(route(), null);
        double[] p = at(250, 0);
        List<Event> ev = e.onFix(new Fix(p[0], p[1], 120, 1.4, -1, 1_000_000));
        assertTrue(speech(ev).isEmpty());
        assertTrue(ev.get(0).state.lowAccuracy);
        assertEquals(0.0, e.progress(), 0.001);
    }

    @Test public void progressNeverGoesBackOnNoise() {
        NavigationEngine e = new NavigationEngine(route(), null);
        List<Long> clk = new ArrayList<>();
        walk(e, 0, 200, 0, 8, 1_000_000, clk);
        double before = e.progress();
        double[] p = at(160, 0); // salto para trás de 40 m (ruído)
        e.onFix(new Fix(p[0], p[1], 8, 1.4, -1, clk.get(0)));
        assertTrue(e.progress() >= before - 0.001);
    }

    @Test public void pausedEngineStaysSilent() {
        NavigationEngine e = new NavigationEngine(route(), null);
        e.setPaused(true);
        assertTrue(speech(walk(e, 0, 330, 0, 8, 1_000_000, new ArrayList<>())).isEmpty());
    }

    @Test public void repeatReturnsLastInstruction() {
        NavigationEngine e = new NavigationEngine(route(), null);
        walk(e, 0, 5, 0, 8, 1_000_000, new ArrayList<>());
        assertEquals("Agora, siga em frente na Rua A.", e.repeat().text);
    }

    @Test public void detailedOffSpeaksOnlyTheTurnNow() {
        NavigationEngine.Config c = new NavigationEngine.Config();
        c.detailed = false;
        NavigationEngine e = new NavigationEngine(route(), c);
        List<String> say = speech(walk(e, 20, 330, 0, 8, 1_000_000, new ArrayList<>()));
        for (String s : say) assertFalse(s, s.startsWith("Em "));
        assertTrue(say.toString(), say.contains("Agora, vire à direita na Rua B."));
    }
}
