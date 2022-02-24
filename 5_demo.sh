# telnet localhost 1234
# BENLEI/1.0


# PING
(echo "open localhost 1234" 
sleep 1 
echo "BENLEI/1.0 PING" 
echo "body data" 
echo 
echo 
sleep 1) | telnet

# JOIN
telnet 127.0.0.1 1234
BENLEI/1.0 JOIN

# BOARDCAST
(echo "open localhost 1234" 
sleep 1 
echo "BENLEI/1.0 BOARDCAST" 
echo "I say hey" 
echo 
echo 
sleep 1) | telnet