-- Answers the keychain access prompt (SecurityAgent) the way a user would:
-- types the keychain password and presses one button. Prints the UI tree it saw.
-- usage: osascript click-prompt.applescript <password> <button title>
on run argv
	set pw to item 1 of argv
	set btn to item 2 of argv
	set report to ""
	tell application "System Events"
		if not (exists process "SecurityAgent") then return "no SecurityAgent process"
		tell process "SecurityAgent"
			if (count of windows) is 0 then return "SecurityAgent has no window"
			set w to window 1
			repeat with e in (UI elements of w)
				try
					set report to report & (class of e as text) & " | " & (name of e as text) & " | " & (role description of e as text) & linefeed
				end try
			end repeat
			-- the password field already has the keyboard focus; secure fields refuse AXValue writes
			set frontmost to true
			delay 0.5
			keystroke pw
			delay 1
			set report to report & "password keystrokes sent" & linefeed
			try
				click button btn of w
				set report to report & "clicked: " & btn & linefeed
			on error errMsg
				set report to report & "click failed: " & errMsg & linefeed
			end try
		end tell
	end tell
	return report
end run
