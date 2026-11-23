import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class ThriftScanServer {
    private static final int PORT = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
    private static final Path ROOT_DIR = Paths.get(".").toAbsolutePath().normalize();

    private static String cachedEbayToken = null;
    private static long cachedEbayTokenExpiry = 0L;

    public static void main(String[] args) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress(PORT), 0);

        server.createContext("/api/health", exchange -> {
            String clientId = System.getenv("EBAY_CLIENT_ID");
            String clientSecret = System.getenv("EBAY_CLIENT_SECRET");
            boolean ebayReady = clientId != null && !clientId.isBlank()
                    && clientSecret != null && !clientSecret.isBlank();
            String json = "{\"ok\":true,\"ebayConfigured\":" + ebayReady + "}";
            sendJson(exchange, 200, json);
        });

        server.createContext("/api/calc", exchange -> {
            if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"error\":\"Method not allowed\"}");
                return;
            }
            String body = readBody(exchange.getRequestBody());
            double buyCost = extractDouble(body, "buyCost", 0.0);
            double salePrice = extractDouble(body, "salePrice", 0.0);
            double shippingCost = extractDouble(body, "shippingCost", 0.0);
            double feeRate = extractDouble(body, "feeRate", 0.136);
            double targetProfit = extractDouble(body, "targetProfit", 25.0);

            double fixedFee = salePrice > 10.0 ? 0.40 : (salePrice > 0.0 ? 0.30 : 0.0);
            double fees = salePrice > 0.0 ? (salePrice * feeRate) + fixedFee : 0.0;
            double netProfit = salePrice - fees - buyCost - shippingCost;
            double maxBuyPrice = Math.max(0.0, salePrice - fees - shippingCost - targetProfit);
            double roiPct = buyCost > 0.0 ? (netProfit / buyCost) * 100.0 : 0.0;

            String json = String.format(
                    Locale.US,
                    "{\"netProfit\":%.2f,\"maxBuyPrice\":%.2f,\"roiPct\":%.2f}",
                    netProfit, maxBuyPrice, roiPct
            );
            sendJson(exchange, 200, json);
        });

        server.createContext("/api/ebay/search", exchange -> {
            String rawQuery = exchange.getRequestURI().getRawQuery();
            String q = extractQueryParam(rawQuery, "q");
            if (q == null || q.isBlank()) {
                sendJson(exchange, 400, "{\"error\":\"Missing q parameter\"}");
                return;
            }
            try {
                String ebayJson = searchEbayBrowse(q.trim());
                sendJson(exchange, 200, ebayJson);
            } catch (Exception ex) {
                sendJson(exchange, 502, "{\"error\":\"" + escapeJson(ex.getMessage()) + "\"}");
            }
        });

        server.createContext("/", ThriftScanServer::handleStaticFile);
        server.setExecutor(null);
        server.start();
        System.out.println("ThriftScan Pro server running at http://localhost:" + PORT);
    }

    private static void handleStaticFile(HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getPath();
        if (path == null || path.equals("/")) {
            path = "/index.html";
        }
        Path resolved = ROOT_DIR.resolve(path.substring(1)).normalize();
        if (!resolved.startsWith(ROOT_DIR) || !Files.exists(resolved) || Files.isDirectory(resolved)) {
            sendText(exchange, 404, "text/plain; charset=utf-8", "Not found");
            return;
        }
        byte[] bytes = Files.readAllBytes(resolved);
        String contentType = detectContentType(resolved.getFileName().toString());
        exchange.getResponseHeaders().set("Content-Type", contentType);
        exchange.sendResponseHeaders(200, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    private static String detectContentType(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html")) return "text/html; charset=utf-8";
        if (lower.endsWith(".css")) return "text/css; charset=utf-8";
        if (lower.endsWith(".js")) return "application/javascript; charset=utf-8";
        if (lower.endsWith(".json")) return "application/json; charset=utf-8";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        return "application/octet-stream";
    }

    private static synchronized String getEbayAppToken() throws IOException {
        long now = System.currentTimeMillis();
        if (cachedEbayToken != null && now < cachedEbayTokenExpiry - 60_000L) {
            return cachedEbayToken;
        }
        String clientId = System.getenv("EBAY_CLIENT_ID");
        String clientSecret = System.getenv("EBAY_CLIENT_SECRET");
        if (clientId == null || clientId.isBlank() || clientSecret == null || clientSecret.isBlank()) {
            throw new IOException("EBAY_CLIENT_ID or EBAY_CLIENT_SECRET environment variable is not set");
        }

        String basicAuth = java.util.Base64.getEncoder()
                .encodeToString((clientId + ":" + clientSecret).getBytes(StandardCharsets.UTF_8));
        String form = "grant_type=client_credentials&scope=" +
                URLEncoder.encode("https://api.ebay.com/oauth/api_scope", StandardCharsets.UTF_8);

        URL url = new URL("https://api.ebay.com/identity/v1/oauth2/token");
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setRequestProperty("Authorization", "Basic " + basicAuth);
        conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");

        try (OutputStream os = conn.getOutputStream()) {
            os.write(form.getBytes(StandardCharsets.UTF_8));
        }

        String resp = readStream(conn.getResponseCode() >= 200 && conn.getResponseCode() < 300
                ? conn.getInputStream() : conn.getErrorStream());
        if (conn.getResponseCode() < 200 || conn.getResponseCode() >= 300) {
            throw new IOException("eBay OAuth HTTP " + conn.getResponseCode() + ": " + resp);
        }

        Matcher m = Pattern.compile("\"access_token\"\\s*:\\s*\"([^\"]+)\"").matcher(resp);
        if (!m.find()) {
            throw new IOException("No access_token in eBay OAuth response");
        }
        Matcher exp = Pattern.compile("\"expires_in\"\\s*:\\s*(\\d+)").matcher(resp);
        long expiresInSec = exp.find() ? Long.parseLong(exp.group(1)) : 7200L;

        cachedEbayToken = m.group(1);
        cachedEbayTokenExpiry = now + (expiresInSec * 1000L);
        return cachedEbayToken;
    }

    private static String searchEbayBrowse(String query) throws IOException {
        String token = getEbayAppToken();
        String endpoint = "https://api.ebay.com/buy/browse/v1/item_summary/search?q=" +
                URLEncoder.encode(query, StandardCharsets.UTF_8) + "&limit=10";

        URL url = new URL(endpoint);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("GET");
        conn.setRequestProperty("Authorization", "Bearer " + token);
        conn.setRequestProperty("X-EBAY-C-MARKETPLACE-ID", "EBAY_US");

        String resp = readStream(conn.getResponseCode() >= 200 && conn.getResponseCode() < 300
                ? conn.getInputStream() : conn.getErrorStream());
        if (conn.getResponseCode() < 200 || conn.getResponseCode() >= 300) {
            throw new IOException("eBay Browse HTTP " + conn.getResponseCode() + ": " + resp);
        }
        return resp;
    }

    private static String extractQueryParam(String rawQuery, String key) {
        if (rawQuery == null || rawQuery.isBlank()) return null;
        for (String pair : rawQuery.split("&")) {
            String[] parts = pair.split("=", 2);
            if (parts.length == 2 && parts[0].equals(key)) {
                return URLDecoder.decode(parts[1], StandardCharsets.UTF_8);
            }
        }
        return null;
    }

    private static double extractDouble(String json, String key, double fallback) {
        if (json == null) return fallback;
        Matcher m = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)").matcher(json);
        return m.find() ? Double.parseDouble(m.group(1)) : fallback;
    }

    private static String readBody(InputStream is) throws IOException {
        return readStream(is);
    }

    private static String readStream(InputStream is) throws IOException {
        if (is == null) return "";
        byte[] buf = is.readAllBytes();
        return new String(buf, StandardCharsets.UTF_8);
    }

    private static void sendJson(HttpExchange exchange, int status, String json) throws IOException {
        sendText(exchange, status, "application/json; charset=utf-8", json);
    }

    private static void sendText(HttpExchange exchange, int status, String contentType, String text) throws IOException {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", contentType);
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    private static String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n");
    }
}
