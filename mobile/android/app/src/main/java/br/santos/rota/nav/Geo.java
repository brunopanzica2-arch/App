package br.santos.rota.nav;

/** Geometria esférica simples (WGS84) usada pelo motor de navegação. Sem dependência de Android: testável na JVM. */
public final class Geo {
    private Geo() {}

    private static final double R = 6371008.8;

    public static double distance(double lat1, double lon1, double lat2, double lon2) {
        double p1 = Math.toRadians(lat1), p2 = Math.toRadians(lat2);
        double dp = p2 - p1, dl = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    /** Rumo inicial de 1 para 2, em graus [0, 360). */
    public static double bearing(double lat1, double lon1, double lat2, double lon2) {
        double p1 = Math.toRadians(lat1), p2 = Math.toRadians(lat2), dl = Math.toRadians(lon2 - lon1);
        double y = Math.sin(dl) * Math.cos(p2);
        double x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
        return (Math.toDegrees(Math.atan2(y, x)) + 360) % 360;
    }

    /** Diferença angular com sinal em (-180, 180]: positivo = virar à direita (horário). */
    public static double turn(double fromBearing, double toBearing) {
        double d = (toBearing - fromBearing + 540) % 360 - 180;
        return d == -180 ? 180 : d;
    }

    /** Resultado da projeção de um ponto numa polilinha. */
    public static final class Projection {
        public final int segment;
        public final double along;    // metros desde o início da polilinha
        public final double lateral;  // distância do ponto à polilinha, em metros
        Projection(int segment, double along, double lateral) { this.segment = segment; this.along = along; this.lateral = lateral; }
    }

    /** Acumulado de distâncias (cum[0] = 0). */
    public static double[] cumulative(double[] lat, double[] lon) {
        double[] cum = new double[lat.length];
        for (int i = 1; i < lat.length; i++) cum[i] = cum[i - 1] + distance(lat[i - 1], lon[i - 1], lat[i], lon[i]);
        return cum;
    }

    /**
     * Projeta (plat, plon) nos segmentos [from, to] da polilinha (plano local equirretangular: erro desprezível a dezenas de metros).
     * Devolve o segmento mais próximo dentro da janela.
     */
    public static Projection project(double[] lat, double[] lon, double[] cum, double plat, double plon, int from, int to) {
        double cosLat = Math.cos(Math.toRadians(plat));
        double mx = Math.PI / 180 * R * cosLat, my = Math.PI / 180 * R;
        int bestSeg = Math.max(0, from);
        double bestLat = Double.MAX_VALUE, bestAlong = 0;
        int a = Math.max(0, from), b = Math.min(lat.length - 2, to);
        for (int i = a; i <= b; i++) {
            double ax = (lon[i] - plon) * mx, ay = (lat[i] - plat) * my;
            double bx = (lon[i + 1] - plon) * mx, by = (lat[i + 1] - plat) * my;
            double dx = bx - ax, dy = by - ay;
            double len2 = dx * dx + dy * dy;
            double t = len2 == 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
            double qx = ax + t * dx, qy = ay + t * dy;
            double d = Math.sqrt(qx * qx + qy * qy);
            if (d < bestLat) {
                bestLat = d;
                bestSeg = i;
                bestAlong = cum[i] + t * (cum[i + 1] - cum[i]);
            }
        }
        return new Projection(bestSeg, bestAlong, bestLat);
    }
}
