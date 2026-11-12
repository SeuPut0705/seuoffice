-- Answers the keychain access prompt (SecurityAgent) the way a user would.
-- usage: osascript click-prompt.applescript <password or -> <button title or ->
-- Types the password into the focused secure field (when not "-"), presses the
-- button (when not "-"), and prints the UI tree it saw.
on run argv
	set pw to item 1 of argv
	set btn to item 2 of argv
	set report to ""
	tell application "System Events"
		repeat 40 times
			if exists process "SecurityAgent" then
				if (count of windows of process "SecurityAgent") > 0 then exit repeat
			end if
			delay 0.5
		end repeat
		if not (exists process "SecurityAgent") then return "no SecurityAgent process"
		tell process "SecurityAgent"
			if (count of windows) is 0 then return "SecurityAgent has no window"
			set w to window 1
			repeat with e in (UI elements of w)
				try
					set report to report & (class of e as text) & " | " & (name of e as text) & " | " & (role description of e as text) & linefeed
				end try
			end repeat
			if pw is not "-" then
				try
					set frontmost to true
				end try
				try
					set focused of text field 1 of w to true
				end try
				delay 0.5
				keystroke pw
				delay 1
				set report to report & "password keystrokes sent" & linefeed
			end if
			if btn is not "-" then
				try
					click button btn of w
					set report to report & "clicked: " & btn & linefeed
				on error errMsg
					set report to report & "click failed: " & errMsg & linefeed
				end try
			end if
		end tell
	end tell
	return report
end run
