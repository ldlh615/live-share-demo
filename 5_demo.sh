(echo "open localhost 1234" 
sleep 1 
echo "BENLEI/1.0 PING" 
echo "hello iam Nanzhu" 
echo 
echo 
sleep 1) | telnet

telnet 127.0.0.1 1234
BENLEI/1.0 JOIN

(echo "open localhost 1234" 
sleep 1 
echo "BENLEI/1.0 BOARDCAST" 
echo "I say hey" 
echo 
echo 
sleep 1) | telnet