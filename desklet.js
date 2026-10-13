const Desklet = imports.ui.desklet;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Main = imports.ui.main;
const Settings = imports.ui.settings;
const ByteArray = imports.byteArray; 
const Mainloop = imports.mainloop;


class AudioVisualizer extends Desklet.Desklet {
    constructor(metadata, desklet_id) {
        super(metadata, desklet_id);
        this.metadata = metadata;
        this.bars = [];
        this.cavaPid = null;
        this.out_reader = null;
        this._micCheckTimeout = null;
        
        this._initContainer();

        // Bind settings
        this.settings = new Settings.DeskletSettings(this, this.metadata.uuid, desklet_id);
        this.settings.bindProperty(Settings.BindingDirection.IN, "bar-color", "bar_color", this.on_settings_changed);
        this.settings.bindProperty(Settings.BindingDirection.IN, "num-bars", "num_bars", this.on_settings_changed);
        this.settings.bindProperty(Settings.BindingDirection.IN, "max-height", "max_height", this.on_settings_changed);
        this.settings.bindProperty(Settings.BindingDirection.IN, "framerate", "framerate", this.on_settings_changed);
        this.settings.bindProperty(Settings.BindingDirection.IN, "opacity", "opacity", this.on_settings_changed);
        this.settings.bindProperty(Settings.BindingDirection.IN, "orientation", "orientation", this.on_settings_changed);
        this.settings.bindProperty(Settings.BindingDirection.IN, "audio-source", "audio_source", this.on_settings_changed);
        
        this.on_settings_changed();
    }

    _initContainer() {
        this.container = new St.BoxLayout({ vertical: false });
        this.setContent(this.container);
    }

    _buildBars() {
        if (!this.container) return; 
        
        this.container.destroy_all_children();
        this.bars = [];
        
        let monitor = Main.layoutManager.primaryMonitor;
        
        let isVertical = this.orientation === "left-to-right" || this.orientation === "right-to-left";
        this.container.vertical = isVertical;
        
        let containerWidth = isVertical ? this.max_height : monitor.width;
        let containerHeight = isVertical ? monitor.height : this.max_height;
        this.container.style = `width: ${containerWidth}px; height: ${containerHeight}px;`;
        
        let barSize = Math.floor((isVertical ? monitor.height : monitor.width) / this.num_bars);
        let opacityVal = Math.floor((this.opacity / 100) * 255);

        for (let i = 0; i < this.num_bars; i++) {
            let barStyle = `background-color: ${this.bar_color}; border-radius: 2px;`;
            let y_align = Clutter.ActorAlign.FILL;
            let x_align = Clutter.ActorAlign.FILL;
            let y_expand = false;
            let x_expand = false;
            
            if (isVertical) {
                barStyle += ` height: ${barSize - 2}px; margin-bottom: 2px;`;
                x_expand = true;
                if (this.orientation === "left-to-right") x_align = Clutter.ActorAlign.START;
                else x_align = Clutter.ActorAlign.END;
            } else {
                barStyle += ` width: ${barSize - 2}px; margin-right: 2px;`;
                y_expand = true;
                if (this.orientation === "top-to-bottom") y_align = Clutter.ActorAlign.START;
                else y_align = Clutter.ActorAlign.END;
            }

            let bar = new St.Widget({
                style: barStyle,
                y_align: y_align,
                y_expand: y_expand,
                x_align: x_align,
                x_expand: x_expand
            });
            
            if (isVertical) bar.set_width(5);
            else bar.set_height(5);
            
            bar.set_opacity(opacityVal);
            
            this.bars.push(bar);
            this.container.add_actor(bar);
        }
    }

    _generateCavaConfig() {
        let configPath = '/tmp/cava-' + this.instance_id + '.conf';
        let sourceConf = 'source = auto';
        
        if (this.audio_source === 'input') {
            let [res, out] = GLib.spawn_command_line_sync('pactl get-default-source');
            if (res && out) {
                let defaultSource = out.toString().trim();
                if (defaultSource) {
                    sourceConf = `source = ${defaultSource}`;
                }
            }
        }
        
        let configContent = `
[general]
bars = ${this.num_bars}
framerate = ${this.framerate}

[input]
method = pulse
${sourceConf}

[output]
channels = stereo
method = raw
raw_target = /dev/stdout
data_format = ascii
ascii_max_range = 1000
`;
        GLib.file_set_contents(configPath, ByteArray.fromString(configContent));
        return configPath;
    }

    _startCava() {
        let configPath = this._generateCavaConfig();
        
        try {
            let [res, pid, in_fd, out_fd, err_fd] = GLib.spawn_async_with_pipes(
                null,
                ['cava', '-p', configPath],
                null,
                GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                null
            );
            
            this.cavaPid = pid;

            this.out_reader = new Gio.DataInputStream({
                base_stream: new Gio.UnixInputStream({ fd: out_fd, close_fd: true })
            });

            this._readOutput(this.out_reader);
        } catch (e) {
            global.logError("Error starting cava: " + e.message);
        }
    }

    _readOutput(reader) {
        if (!reader || reader.is_closed()) return;

        reader.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, res) => {
            try {
                let [line, length] = source.read_line_finish_utf8(res);
                if (line) {
                    this._updateBars(line);
                    this._readOutput(source); 
                }
            } catch (e) {
                // Stream closed safely
            }
        });
    }

    _updateBars(line) {
        let values = line.split(';').filter(v => v !== '');
        let isVertical = this.orientation === "left-to-right" || this.orientation === "right-to-left";
        
        for (let i = 0; i < values.length && i < this.bars.length; i++) {
            let val = parseInt(values[i], 10);
            if (isNaN(val)) val = 0;
            
            let newSize = (val / 1000) * this.max_height;
            if (newSize < 5) newSize = 5;
            
            if (isVertical) {
                this.bars[i].set_width(newSize);
            } else {
                this.bars[i].set_height(newSize);
            }
        }
    }

    _stopCava() {
        if (this.cavaPid) {
            GLib.spawn_command_line_async('kill -9 ' + this.cavaPid);
            this.cavaPid = null;
        }
        if (this.out_reader) {
            try {
                this.out_reader.close(null);
            } catch (e) {
                // Ignore outstanding operation error
            }
            this.out_reader = null;
        }
    }

    _clearMicCheck() {
        if (this._micCheckTimeout) {
            Mainloop.source_remove(this._micCheckTimeout);
            this._micCheckTimeout = null;
        }
    }

    _checkMicActive() {
        if (this.audio_source !== "input") return;
        
        let [res, out] = GLib.spawn_command_line_sync('pactl list source-outputs');
        let micActive = false;
        
        if (res && out) {
            let output = out.toString();
            let blocks = output.split('Source Output #');
            
            for (let i = 1; i < blocks.length; i++) {
                let block = blocks[i];
                let isInput = !block.includes('stream.capture.sink = "true"');
                let isOurCava = this.cavaPid && block.includes('application.process.id = "' + this.cavaPid + '"');
                
                if (isInput && !isOurCava) {
                    micActive = true;
                    break;
                }
            }
        }
        
        if (micActive && !this.cavaPid) {
            this.container.show();
            this._startCava();
        } else if (!micActive && this.cavaPid) {
            this.container.hide();
            this._stopCava();
        }
        
        if (this.audio_source === "input") {
            this._micCheckTimeout = Mainloop.timeout_add(2000, () => {
                this._checkMicActive();
                return false;
            });
        }
    }

    on_settings_changed() {
        this._clearMicCheck();
        this._stopCava();
        this._buildBars();
        
        if (this.audio_source === "input") {
            this.container.hide();
            this._checkMicActive();
        } else {
            this.container.show();
            this._startCava();
        }
    }

    on_desklet_removed() {
        this._clearMicCheck();
        this._stopCava();
    }
}

function main(metadata, desklet_id) {
    return new AudioVisualizer(metadata, desklet_id);
}
