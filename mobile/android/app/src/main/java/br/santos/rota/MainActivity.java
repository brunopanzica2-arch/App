package br.santos.rota;

import android.os.Bundle;
import br.santos.rota.nav.RotaNavPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RotaNavPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
