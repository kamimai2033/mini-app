FROM freshrss/freshrss:1.30.4
COPY freshrss/apply-policy.php /news/apply-policy.php
RUN php /news/apply-policy.php
COPY freshrss/news-bridge.php /var/www/FreshRSS/p/api/news-bridge.php
COPY freshrss/bootstrap.php freshrss/run.sh /news/
RUN chmod 755 /news/run.sh && php -l /var/www/FreshRSS/p/api/news-bridge.php && php -l /news/bootstrap.php
ENV CRON_MIN="*/15" ENABLE_ACCESS_LOG=0
CMD ["/news/run.sh"]
